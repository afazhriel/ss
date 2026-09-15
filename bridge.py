#!/usr/bin/env python3

import json
import mimetypes
import os
import shutil
import socket
import subprocess
import threading
import time
import tinytuya
import paho.mqtt.client as mqtt

from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo


# ============================================================
# CONFIG
# ============================================================

CONFIG_FILE = "/home/aptek/tuya-gateway.json"
TIMEZONE = ZoneInfo("Asia/Jakarta")

BATTERY_REFRESH = 300
NVR_CHECK_INTERVAL = 20
NVR_CONNECT_TIMEOUT = 2

API_HOST = "0.0.0.0"
API_PORT = 8088

CCTV_PUBLIC_URL_FILE = Path(
    "/opt/security-system/tuya-bridge/cctv_public_url.txt"
)


# ============================================================
# MQTT CONFIG
# ============================================================

MQTT_HOST = os.getenv("MQTT_HOST", "")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "v1/telemetry")

MQTT_PUBLISH_INTERVAL = 20

PANIC_HOLD_SECONDS = 5
PANIC_RESET_TIMER = None
MQTT_QOS = 1
MQTT_RETAIN = True

MQTT_CLIENT = None
MQTT_CONNECTED = False

NVR_IP = "192.168.1.50"
NVR_RTSP_PORT = 554
NVR_TOTAL_CAMERAS = 2

NVR_USERNAME = os.getenv("NVR_USERNAME", "admin")
NVR_PASSWORD = os.getenv("NVR_PASSWORD", "")

# Untuk tahap awal hanya Camera 1 dan Camera 2
LIVE_CAMERAS = {
    1: {
        "name": "Camera 1",
        "channel": 102,
    },
    2: {
        "name": "Camera 2",
        "channel": 202,
    },
}

HLS_ROOT = Path("/tmp/security-system-hls")
STREAM_PROCESSES = {}

CAMERA_START_DELAY = 0.7


with open(CONFIG_FILE, "r") as f:
    config = json.load(f)

GATEWAY_ID = config["device_id"]
GATEWAY_IP = config["host"]
GATEWAY_LOCAL_KEY = config["local_key"]
GATEWAY_VERSION = float(
    config.get("protocol_version", 3.4)
)


# ============================================================
# TUYA DEVICE MAPPING
# ============================================================

DEVICES = {
    "a4c1382ce22330e4": {
        "name": "alarm",
        "state_dps": "13",
        "battery_dps": "15",
    },

    "a4c1382393f38881": {
        "name": "smoke",
        "state_dps": "1",
        "battery_dps": "15",
    },

    "a4c1388fde36d728": {
        "name": "water_leak",
        "state_dps": "1",
        "battery_dps": "4",
    },

    "a4c13853dd0a8e88": {
        "name": "panic",
        "state_dps": "29",
        "battery_dps": "3",
    },

    "a4c1384ee6e84c0f": {
        "name": "pir",
        "state_dps": "101",
        "battery_dps": "103",
    },

    "a4c138850f7b81e0": {
        "name": "door",
        "state_dps": "1",
        "battery_dps": "2",
    },
}


# ============================================================
# STATE
# ============================================================

STATE = {}

for cfg in DEVICES.values():

    name = cfg["name"]

    STATE[f"state_{name}"] = "OFF"
    STATE[f"battery_{name}"] = None


STATE.update({
    "last_panic": None,

    "state_nvr": "OFF",
    "nvr_ip": NVR_IP,
    "nvr_rtsp_port": NVR_RTSP_PORT,
    "nvr_camera_count": NVR_TOTAL_CAMERAS,

    "live_camera_count": len(LIVE_CAMERAS),

    "timestamp": None,
})


# ============================================================
# HELPERS
# ============================================================

def get_cctv_public_url():

    try:

        return CCTV_PUBLIC_URL_FILE.read_text(
            encoding="utf-8"
        ).strip()

    except (
        FileNotFoundError,
        PermissionError,
        OSError,
    ):

        return ""


def timestamp():

    return datetime.now(
        TIMEZONE
    ).isoformat(
        timespec="seconds"
    )


def normalize_state(name, value):

    if isinstance(value, bool):

        return (
            "ON"
            if value
            else "OFF"
        )


    value = str(value).lower()


    if name in (
        "smoke",
        "water_leak",
    ):

        if value == "alarm":
            return "ON"

        if value == "normal":
            return "OFF"


    if (
        name == "panic"
        and value == "sos"
    ):

        return "ON"


    return str(value).upper()


def print_state():

    STATE["timestamp"] = timestamp()

    print(
        json.dumps(
            STATE,
            indent=2,
            ensure_ascii=False,
        )
    )


# ============================================================
# TUYA STATE UPDATE
# ============================================================

def update_device_state(
    cid,
    dps,
    realtime=False,
):

    if cid not in DEVICES:
        return False


    cfg = DEVICES[cid]

    name = cfg["name"]

    state_dps = cfg["state_dps"]
    battery_dps = cfg["battery_dps"]

    changed = False


    if state_dps in dps:

        # Panic adalah event
        if name == "panic":

            if realtime:

                STATE[
                    "state_panic"
                ] = normalize_state(
                    name,
                    dps[state_dps],
                )

                STATE[
                    "last_panic"
                ] = timestamp()

                changed = True


        else:

            STATE[
                f"state_{name}"
            ] = normalize_state(
                name,
                dps[state_dps],
            )

            changed = True


    if battery_dps in dps:

        STATE[
            f"battery_{name}"
        ] = dps[
            battery_dps
        ]

        changed = True


    return changed


# ============================================================
# MQTT
# ============================================================

def build_mqtt_payload():

    return {
        "state_alarm": STATE["state_alarm"],
        "battery_alarm": STATE["battery_alarm"],

        "state_smoke": STATE["state_smoke"],
        "battery_smoke": STATE["battery_smoke"],

        "state_water_leak": STATE["state_water_leak"],
        "battery_water_leak": STATE["battery_water_leak"],

        "state_panic": STATE["state_panic"],
        "battery_panic": STATE["battery_panic"],
        "last_panic": STATE["last_panic"],

        "state_pir": STATE["state_pir"],
        "battery_pir": STATE["battery_pir"],

        "state_door": STATE["state_door"],
        "battery_door": STATE["battery_door"],

        "state_nvr": STATE["state_nvr"],

        "cctv_public_url": get_cctv_public_url(),

        "timestamp": timestamp(),
    }


def reset_panic_state():

    global PANIC_RESET_TIMER

    STATE["state_panic"] = "OFF"

    publish_mqtt(
        "panic_reset"
    )

    print(
        f"[{timestamp()}] "
        "PANIC RESET -> OFF"
    )

    PANIC_RESET_TIMER = None


def schedule_panic_reset():

    global PANIC_RESET_TIMER

    # Kalau tombol dipencet lagi sebelum 5 detik,
    # hitungan 5 detik dimulai ulang.
    if PANIC_RESET_TIMER is not None:
        PANIC_RESET_TIMER.cancel()

    PANIC_RESET_TIMER = threading.Timer(
        PANIC_HOLD_SECONDS,
        reset_panic_state,
    )

    PANIC_RESET_TIMER.daemon = True
    PANIC_RESET_TIMER.start()


def on_mqtt_connect(
    client,
    userdata,
    flags,
    reason_code,
    properties,
):

    global MQTT_CONNECTED

    MQTT_CONNECTED = (
        reason_code == 0
    )

    if MQTT_CONNECTED:

        print(
            f"MQTT connected: "
            f"{MQTT_HOST}:{MQTT_PORT}"
        )

    else:

        print(
            f"MQTT connection failed: "
            f"{reason_code}"
        )


def on_mqtt_disconnect(
    client,
    userdata,
    disconnect_flags,
    reason_code,
    properties,
):

    global MQTT_CONNECTED

    MQTT_CONNECTED = False

    print(
        f"MQTT disconnected: "
        f"{reason_code}"
    )


def start_mqtt():

    global MQTT_CLIENT

    if not MQTT_HOST:

        print("MQTT disabled: MQTT_HOST kosong")
        return


    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="security-system-bridge",
        protocol=mqtt.MQTTv311,
    )


    if MQTT_USERNAME:

        client.username_pw_set(
            MQTT_USERNAME,
            MQTT_PASSWORD,
        )


    client.on_connect = on_mqtt_connect
    client.on_disconnect = on_mqtt_disconnect

    client.reconnect_delay_set(
        min_delay=1,
        max_delay=30,
    )


    print()
    print("MQTT")
    print("-" * 60)
    print(f"Broker      : {MQTT_HOST}")
    print(f"Port        : {MQTT_PORT}")
    print(f"Topic       : {MQTT_TOPIC}")
    print(f"Username    : {MQTT_USERNAME}")
    print("Password    : ********")
    print(
        f"Publish     : realtime + "
        f"{MQTT_PUBLISH_INTERVAL}s"
    )


    try:

        client.connect(
            MQTT_HOST,
            MQTT_PORT,
            10,
        )

        client.loop_start()

        MQTT_CLIENT = client

    except Exception as e:

        print(
            f"MQTT startup error: "
            f"{type(e).__name__}: {e}"
        )


def publish_mqtt(reason="periodic"):

    if (
        MQTT_CLIENT is None
        or not MQTT_CONNECTED
    ):

        return False


    payload = build_mqtt_payload()


    try:

        result = MQTT_CLIENT.publish(
            MQTT_TOPIC,
            json.dumps(
                payload,
                ensure_ascii=False,
            ),
            qos=MQTT_QOS,
            retain=MQTT_RETAIN,
        )


        if result.rc != mqtt.MQTT_ERR_SUCCESS:

            print(
                f"MQTT publish error: "
                f"{result.rc}"
            )

            return False


        if reason != "periodic":

            print(
                f"MQTT publish: "
                f"{reason} -> {MQTT_TOPIC}"
            )


        return True


    except Exception as e:

        print(
            f"MQTT publish exception: "
            f"{type(e).__name__}: {e}"
        )

        return False


# ============================================================
# NVR
# ============================================================

def check_nvr():

    try:

        with socket.create_connection(
            (
                NVR_IP,
                NVR_RTSP_PORT,
            ),
            timeout=NVR_CONNECT_TIMEOUT,
        ):

            return True


    except (
        socket.timeout,
        ConnectionRefusedError,
        OSError,
    ):

        return False


def get_rtsp_url(camera_number):

    channel = LIVE_CAMERAS[
        camera_number
    ]["channel"]


    username = quote(
        NVR_USERNAME,
        safe="",
    )

    password = quote(
    NVR_PASSWORD,
    safe="",
)


    return (
        f"rtsp://"
        f"{username}:{password}"
        f"@{NVR_IP}:{NVR_RTSP_PORT}"
        f"/Streaming/Channels/{channel}"
    )


# ============================================================
# HLS LIVE STREAM
# ============================================================

def camera_dir(camera_number):

    return (
        HLS_ROOT
        / f"camera_{camera_number}"
    )


def camera_playlist(camera_number):

    return (
        camera_dir(
            camera_number
        )
        / "index.m3u8"
    )


def camera_running(camera_number):

    process = STREAM_PROCESSES.get(
        camera_number
    )

    return (
        process is not None
        and process.poll() is None
    )


def stop_camera(camera_number):

    process = STREAM_PROCESSES.get(
        camera_number
    )

    if process is None:
        return

    try:

        # Kalau FFmpeg masih hidup, hentikan dengan baik
        if process.poll() is None:

            process.terminate()

            try:
                process.wait(
                    timeout=3
                )

            except subprocess.TimeoutExpired:

                process.kill()

                # Penting: reap setelah kill
                try:
                    process.wait(
                        timeout=2
                    )
                except Exception:
                    pass

        else:

            # Kalau proses sudah mati, pastikan child process direap
            try:
                process.wait(
                    timeout=0.2
                )
            except Exception:
                pass

    finally:

        STREAM_PROCESSES.pop(
            camera_number,
            None,
        )


def start_camera(camera_number):

    if camera_running(
        camera_number
    ):

        return


    stream_dir = camera_dir(
        camera_number
    )


    stream_dir.mkdir(
        parents=True,
        exist_ok=True,
    )


    # Hapus segment lama
    for old_file in stream_dir.iterdir():

        if old_file.is_file():

            try:

                old_file.unlink()

            except OSError:

                pass


    playlist = camera_playlist(
        camera_number
    )


    command = [
        "ffmpeg",

        "-hide_banner",

        "-loglevel",
        "error",

        "-nostdin",

        "-rtsp_transport",
        "tcp",

        "-i",
        get_rtsp_url(
            camera_number
        ),

        # Video saja dulu
        "-map",
        "0:v:0",

        "-an",

        # Tidak encode ulang
        "-c:v",
        "copy",

        "-f",
        "hls",

        "-hls_time",
        "1",

        "-hls_list_size",
        "4",

        "-hls_flags",
        "delete_segments+append_list+omit_endlist",

        "-hls_segment_filename",
        str(
            stream_dir
            / "segment_%05d.ts"
        ),

        str(
            playlist
        ),
    ]


    log_path = stream_dir / "ffmpeg.log"

    log_file = open(
        log_path,
        "a",
    )

    process = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=log_file,
    )


    STREAM_PROCESSES[
        camera_number
    ] = process


    print(
        f"Camera {camera_number} "
        f"HLS started "
        f"(channel "
        f"{LIVE_CAMERAS[camera_number]['channel']})"
    )


def ensure_camera_streams():

    # Kalau NVR mati, stop semua stream
    if STATE["state_nvr"] != "ON":

        for camera_number in LIVE_CAMERAS:
            stop_camera(camera_number)

        return

    # Sementara test Camera 1 saja
    for camera_number in LIVE_CAMERAS:

        if camera_running(
            camera_number
        ):
            continue

        print(
            f"Starting Camera {camera_number}..."
        )

        start_camera(
            camera_number
        )

        time.sleep(
            CAMERA_START_DELAY
        )

def stop_all_camera_streams():

    for camera_number in list(
        STREAM_PROCESSES
    ):

        stop_camera(
            camera_number
        )


# ============================================================
# LOCAL HTTP API
# ============================================================

class APIHandler(
    BaseHTTPRequestHandler
):


    def send_json(
        self,
        status_code,
        payload,
    ):

        body = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode(
            "utf-8"
        )


        self.send_response(
            status_code
        )

        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )

        self.send_header(
            "Content-Length",
            str(
                len(body)
            ),
        )

        self.send_header(
            "Access-Control-Allow-Origin",
            "*",
        )

        self.send_header(
            "Cache-Control",
            "no-store",
        )

        self.end_headers()

        self.wfile.write(
            body
        )


    def send_hls(
        self,
        relative_path,
    ):

        root = HLS_ROOT.resolve()

        requested = (
            HLS_ROOT
            / relative_path
        ).resolve()


        # Proteksi path traversal
        try:

            requested.relative_to(
                root
            )


        except ValueError:

            self.send_json(
                403,
                {
                    "error": "Forbidden",
                },
            )

            return


        if not requested.is_file():

            self.send_json(
                404,
                {
                    "error":
                    "Stream not ready",
                },
            )

            return


        if (
            requested.suffix
            == ".m3u8"
        ):

            content_type = (
                "application/vnd.apple.mpegurl"
            )


        elif (
            requested.suffix
            == ".ts"
        ):

            content_type = (
                "video/mp2t"
            )


        else:

            content_type = (
                mimetypes.guess_type(
                    str(
                        requested
                    )
                )[0]
                or
                "application/octet-stream"
            )


        try:

            body = (
                requested.read_bytes()
            )


        except OSError:

            self.send_json(
                500,
                {
                    "error":
                    "Unable to read stream file",
                },
            )

            return


        self.send_response(
            200
        )

        self.send_header(
            "Content-Type",
            content_type,
        )

        self.send_header(
            "Content-Length",
            str(
                len(body)
            ),
        )

        self.send_header(
            "Access-Control-Allow-Origin",
            "*",
        )

        self.send_header(
            "Cache-Control",
            "no-cache",
        )

        self.end_headers()

        self.wfile.write(
            body
        )


    def do_GET(self):

        path = urlparse(
            self.path
        ).path


        # ----------------------------------------------------
        # STATE
        # ----------------------------------------------------

        if path == "/api/state":

            payload = dict(
                STATE
            )

            payload[
                "timestamp"
            ] = timestamp()

            payload[
                "cctv_public_url"
            ] = get_cctv_public_url()


            self.send_json(
                200,
                payload,
            )

            return


        # ----------------------------------------------------
        # HEALTH
        # ----------------------------------------------------

        if path == "/api/health":

            self.send_json(
                200,
                {
                    "status": "OK",

                    "service":
                    "security-system-bridge",

                    "timestamp":
                    timestamp(),
                },
            )

            return


        # ----------------------------------------------------
        # CAMERA LIST
        # ----------------------------------------------------

        if path == "/api/cameras":

            cameras = []


            for (
                camera_number,
                cfg,
            ) in LIVE_CAMERAS.items():


                cameras.append({

                    "id":
                    camera_number,

                    "name":
                    cfg["name"],

                    "channel":
                    cfg["channel"],

                    "streaming":
                    camera_running(
                        camera_number
                    ),

                    "ready":
                    camera_playlist(
                        camera_number
                    ).exists(),

                    "live":
                    (
                        f"/hls/"
                        f"camera_{camera_number}/"
                        f"index.m3u8"
                    ),

                })


            self.send_json(
                200,
                {
                    "nvr_online":
                    STATE[
                        "state_nvr"
                    ] == "ON",

                    "total_nvr_cameras":
                    NVR_TOTAL_CAMERAS,

                    "live_camera_count":
                    len(
                        LIVE_CAMERAS
                    ),

                    "cameras":
                    cameras,
                },
            )

            return


        # ----------------------------------------------------
        # HLS
        # ----------------------------------------------------

        if path.startswith(
            "/hls/"
        ):

            self.send_hls(
                path[
                    len("/hls/"):
                ]
            )

            return


        # ----------------------------------------------------
        # ROOT
        # ----------------------------------------------------

        if path == "/":

            self.send_json(
                200,
                {
                    "service":
                    "Security System Bridge API",

                    "endpoints": [
                        "/api/state",
                        "/api/health",
                        "/api/cameras",

                        "/hls/camera_1/index.m3u8",
                        "/hls/camera_2/index.m3u8",
                    ],
                },
            )

            return


        self.send_json(
            404,
            {
                "error":
                "Not Found",
            },
        )


    def log_message(
        self,
        format,
        *args,
    ):

        return


def run_api():

    server = ThreadingHTTPServer(
        (
            API_HOST,
            API_PORT,
        ),
        APIHandler,
    )


    print()
    print("LOCAL API")
    print("-" * 60)

    print(
        "State API   : "
        f"http://192.168.1.140:"
        f"{API_PORT}/api/state"
    )

    print(
        "Camera API  : "
        f"http://192.168.1.140:"
        f"{API_PORT}/api/cameras"
    )

    print(
        "Camera 1    : "
        f"http://192.168.1.140:"
        f"{API_PORT}/hls/"
        "camera_1/index.m3u8"
    )

    print(
        "Camera 2    : "
        f"http://192.168.1.140:"
        f"{API_PORT}/hls/"
        "camera_2/index.m3u8"
    )


    server.serve_forever()


def start_api():

    threading.Thread(
        target=run_api,
        daemon=True,
        name="local-api",
    ).start()


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 60)
    print("SECURITY SYSTEM BRIDGE")
    print("=" * 60)


    start_api()
    start_mqtt()


    print()
    print("TUYA GATEWAY")
    print("-" * 60)

    print(
        f"Gateway ID : {GATEWAY_ID}"
    )

    print(
        f"Gateway IP : {GATEWAY_IP}"
    )

    print(
        f"Version    : {GATEWAY_VERSION}"
    )


    print()
    print("HIKVISION NVR")
    print("-" * 60)

    print(
        f"NVR IP     : {NVR_IP}"
    )

    print(
        f"RTSP Port  : {NVR_RTSP_PORT}"
    )

    print(
        f"NVR Cameras: {NVR_TOTAL_CAMERAS}"
    )

    print(
        f"Live Cams  : {len(LIVE_CAMERAS)}"
    )

    print(
        f"Username   : {NVR_USERNAME}"
    )

    print(
        "Password   : ********"
    )

    print(
        "Timezone   : Asia/Jakarta"
    )


    # ========================================================
    # TUYA
    # ========================================================

    gw = tinytuya.Device(
        GATEWAY_ID,
        address=GATEWAY_IP,
        local_key=GATEWAY_LOCAL_KEY,
        version=GATEWAY_VERSION,
        persist=True,
    )

    gw.set_socketTimeout(
        5
    )

    gw.set_socketRetryLimit(
        1
    )


    children = {}


    print()
    print("TUYA DEVICES")
    print("-" * 60)


    for cid, cfg in DEVICES.items():

        child = tinytuya.Device(
            cid,
            cid=cid,
            parent=gw,
        )


        child.set_dpsUsed({
            cfg[
                "state_dps"
            ]: None,

            cfg[
                "battery_dps"
            ]: None,
        })


        children[
            cid
        ] = child


        print(
            f"Registered: "
            f"{cfg['name']:12} "
            f"CID={cid}"
        )


    # ========================================================
    # CAMERA MAPPING
    # ========================================================

    print()
    print("LIVE CAMERA MAPPING")
    print("-" * 60)


    for (
        camera_number,
        cfg,
    ) in LIVE_CAMERAS.items():

        print(
            f"camera_{camera_number}     "
            f"CHANNEL={cfg['channel']}"
        )


    print("-" * 60)


    # ========================================================
    # NVR CHECK
    # ========================================================

    print()
    print("Checking NVR...")


    STATE[
        "state_nvr"
    ] = (
        "ON"
        if check_nvr()
        else "OFF"
    )


    print(
        f"NVR "
        f"{NVR_IP}:"
        f"{NVR_RTSP_PORT} "
        f"{'ONLINE' if STATE['state_nvr'] == 'ON' else 'OFFLINE'}"
    )


    # Start 2 camera live
    ensure_camera_streams()


    # ========================================================
    # INITIAL TUYA STATE
    # ========================================================

    print()
    print(
        "Reading initial state + battery..."
    )
    print("-" * 60)


    for (
        cid,
        child,
    ) in children.items():

        name = DEVICES[
            cid
        ]["name"]


        try:

            result = (
                child.status()
            )

            dps = result.get(
                "dps",
                {},
            )


            if dps:

                update_device_state(
                    cid,
                    dps,
                    realtime=False,
                )


                print(
                    f"{name:12} "
                    f"OK {dps}"
                )


            else:

                print(
                    f"{name:12} "
                    "NO DATA"
                )


        except Exception as e:

            print(
                f"{name:12} "
                f"ERROR: {e}"
            )


        time.sleep(
            0.5
        )


    STATE[
        "state_panic"
    ] = "OFF"


    print()
    print(
        "INITIAL CACHE:"
    )

    print_state()

    publish_mqtt("initial")


    print()
    print("=" * 60)
    print("Listening realtime...")
    print("=" * 60)


    last_battery_refresh = (
        time.monotonic()
    )

    last_nvr_check = (
        time.monotonic()
    )

    last_mqtt_publish = (
        time.monotonic()
    )


    # ========================================================
    # LOOP
    # ========================================================

    while True:

        try:

            data = gw.receive()


            # ------------------------------------------------
            # REALTIME TUYA
            # ------------------------------------------------

            if (
                data
                and data.get(
                    "Err"
                ) not in (
                    "900",
                    "904",
                )
            ):

                child = data.get(
                    "device"
                )


                cid = (
                    getattr(
                        child,
                        "cid",
                        None,
                    )
                    if child
                    else None
                )


                if not cid:

                    cid = (
                        data
                        .get(
                            "data",
                            {},
                        )
                        .get(
                            "cid"
                        )
                    )


                dps = (
                    data.get(
                        "dps"
                    )
                    or
                    data
                    .get(
                        "data",
                        {},
                    )
                    .get(
                        "dps",
                        {},
                    )
                )


                if (
                    cid
                    and dps
                    and cid in DEVICES
                ):

                    if update_device_state(
                        cid,
                        dps,
                        realtime=True,
                    ):

                        name = (
                            DEVICES[
                                cid
                            ][
                                "name"
                            ]
                        )


                        print()

                        print(
                            f"[{timestamp()}] "
                            f"{name.upper()}"
                        )

                        print(
                            f"DPS: {dps}"
                        )


                        print_state()

                        # Publish state realtime
                        publish_mqtt("event")


                        if (
                            name
                            == "panic"
                        ):

                            # Pertahankan PANIC ON selama 5 detik.
                            schedule_panic_reset()


                        print(
                            "-" * 60
                        )


            now = time.monotonic()


            # ------------------------------------------------
            # PERIODIC MQTT
            # ------------------------------------------------

            if (
                now
                - last_mqtt_publish
                >= MQTT_PUBLISH_INTERVAL
            ):

                publish_mqtt(
                    "periodic"
                )

                last_mqtt_publish = now


            # ------------------------------------------------
            # NVR CHECK + STREAM SUPERVISOR
            # ------------------------------------------------

            if (
                now
                - last_nvr_check
                >= NVR_CHECK_INTERVAL
            ):

                previous_state = (
                    STATE[
                        "state_nvr"
                    ]
                )


                STATE[
                    "state_nvr"
                ] = (
                    "ON"
                    if check_nvr()
                    else "OFF"
                )


                if (
                    STATE[
                        "state_nvr"
                    ]
                    != previous_state
                ):

                    print()

                    print(
                        f"[{timestamp()}] "
                        f"NVR "
                        f"{STATE['state_nvr']}"
                    )

                    print_state()

                    print(
                        "-" * 60
                    )


                ensure_camera_streams()


                last_nvr_check = now


            # ------------------------------------------------
            # BATTERY REFRESH
            # ------------------------------------------------

            if (
                now
                - last_battery_refresh
                >= BATTERY_REFRESH
            ):

                print()

                print(
                    f"[{timestamp()}] "
                    "Refreshing battery..."
                )


                for (
                    cid,
                    child,
                ) in children.items():

                    try:

                        result = (
                            child.status()
                        )

                        dps = result.get(
                            "dps",
                            {},
                        )


                        if dps:

                            update_device_state(
                                cid,
                                dps,
                                realtime=False,
                            )


                    except Exception:

                        pass


                    time.sleep(
                        0.3
                    )


                STATE[
                    "state_panic"
                ] = "OFF"


                print_state()

                publish_mqtt(
                    "battery_refresh"
                )


                last_battery_refresh = now


        except KeyboardInterrupt:

            print()

            print(
                "Stopping camera streams..."
            )


            stop_all_camera_streams()


            if HLS_ROOT.exists():

                try:

                    shutil.rmtree(
                        HLS_ROOT
                    )

                except OSError:

                    pass


            print(
                "Bridge stopped."
            )

            break


        except Exception as e:

            print(
                f"ERROR: "
                f"{type(e).__name__}: "
                f"{e}"
            )

            time.sleep(
                2
            )


if __name__ == "__main__":

    main()
