import express from "express";
import cors from "cors";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  writeFile,
  unlink,
  mkdir,
  rm,
  access,
  readdir,
  stat
} from "node:fs/promises";

import {
  XMLParser
} from "fast-xml-parser";


/* ============================================================
   CONFIG
   ============================================================ */

const app = express();

const PORT =
  Number(
    process.env.PORT ||
    8090
  );

const NVR_HOST =
  process.env.NVR_HOST ||
  "";

const NVR_RTSP_PORT =
  process.env.NVR_RTSP_PORT ||
  "554";

const NVR_USERNAME =
  process.env.NVR_USERNAME ||
  "";

const NVR_PASSWORD =
  process.env.NVR_PASSWORD ||
  "";

const PLAYBACK_PUBLIC_TOKEN =
  process.env.PLAYBACK_PUBLIC_TOKEN ||
  "";

const FFMPEG_BIN =
  process.env.FFMPEG_BIN ||
  "/usr/bin/ffmpeg";

const TIMEZONE =
  "Asia/Jakarta";

const HLS_PLAYBACK_ROOT =
  "/tmp/security-playback-hls";

const HLS_CACHE_MAX_BYTES =
  5 * 1024 * 1024 * 1024; // 5 GB

const HLS_RETENTION_MS =
  12 * 60 * 60 * 1000; // 12 jam

/* ============================================================
   PLAYBACK PROCESS CONTROL
   ============================================================ */

const PLAYBACK_START_TIMEOUT_MS =
  15000;

const PLAYBACK_STALL_TIMEOUT_MS =
  30000;

const PLAYBACK_KILL_GRACE_MS =
  2500;

let activePlayback =
  null;



/*
 * PENTING:
 *
 * Hikvision DS-7104NI-Q1/M ini mengembalikan timestamp seperti:
 *
 *   2026-09-15T10:40:22Z
 *
 * tetapi angka jam tersebut ternyata merupakan JAM LOKAL WIB,
 * bukan UTC sebenarnya.
 *
 * Jadi:
 *
 *   User pilih 10:50 WIB
 *
 * harus dikirim ke ISAPI sebagai:
 *
 *   2026-09-15T10:50:00Z
 *
 * BUKAN:
 *
 *   2026-09-15T03:50:00Z
 *
 * Jangan melakukan konversi UTC terhadap timestamp ISAPI/RTSP
 * untuk NVR ini.
 */


/* ============================================================
   XML
   ============================================================ */

const xmlParser =
  new XMLParser({
    ignoreAttributes: false,
    trimValues: true
  });


/* ============================================================
   EXPRESS
   ============================================================ */

app.disable("x-powered-by");

app.use(
  cors({
    origin: "*",
    methods: [
      "GET",
      "OPTIONS"
    ]
  })
);

app.use(
  express.json()
);

app.use(
  (req, res, next) => {

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    next();

  }
);



/* ============================================================
   PUBLIC PLAYBACK AUTH
   ============================================================ */

app.use(
  (req, res, next) => {

    /*
     * Request dari Cloudflare Quick Tunnel memiliki header CF.
     * Request lokal/LAN tidak diwajibkan menggunakan token.
     */
    const fromCloudflare =
      Boolean(
        req.headers["cf-ray"] ||
        req.headers["cf-connecting-ip"]
      );


    /*
     * Hanya endpoint playback yang sensitif.
     *
     * File HLS memakai session UUID acak dan diperlukan langsung
     * oleh HLS.js, sehingga file segment tidak meminta Bearer token.
     */
    const protectedPlaybackPath =
      req.path.startsWith(
        "/api/playback/"
      ) &&
      !req.path.startsWith(
        "/api/playback/hls/files/"
      );


    if (
      req.method === "OPTIONS" ||
      !fromCloudflare ||
      !protectedPlaybackPath
    ) {

      return next();

    }


    if (
      !PLAYBACK_PUBLIC_TOKEN
    ) {

      return res.status(503).json({
        error:
          "Public playback authentication is not configured"
      });

    }


    const authorization =
      String(
        req.headers.authorization ||
        ""
      );


    const expected =
      `Bearer ${PLAYBACK_PUBLIC_TOKEN}`;


    if (
      authorization !== expected
    ) {

      res.setHeader(
        "WWW-Authenticate",
        "Bearer"
      );


      return res.status(401).json({
        error:
          "Unauthorized"
      });

    }


    next();

  }
);


/* ============================================================
   ROOT
   ============================================================ */

app.get(
  "/",
  (req, res) => {

    res.json({

      status:
        "OK",

      service:
        "CCTV Playback API",

      nvr_time_semantics:
        "LOCAL_WIB_WITH_Z_SUFFIX",

      endpoints: [

        "/api/health",

        "/api/playback/search?camera=1&date=2026-09-15",

        "/api/playback/stream?camera=1&date=2026-09-15&start=10:50:00&end=10:51:00",

        "/api/playback/download?camera=1&date=2026-09-15&start=10:50:00&end=10:51:00"

      ]

    });

  }
);


/* ============================================================
   HEALTH
   ============================================================ */

app.get(
  "/api/health",
  (req, res) => {

    const environmentOK =
      Boolean(
        NVR_HOST &&
        NVR_RTSP_PORT &&
        NVR_USERNAME &&
        NVR_PASSWORD
      );


    res.json({

      status:
        "OK",

      service:
        "CCTV Playback API",

      port:
        PORT,

      environment:
        environmentOK
          ? "OK"
          : "INCOMPLETE",

      nvr: {

        host:
          NVR_HOST,

        rtsp_port:
          NVR_RTSP_PORT,

        username_set:
          Boolean(
            NVR_USERNAME
          ),

        password_set:
          Boolean(
            NVR_PASSWORD
          )

      },

      ffmpeg:
        FFMPEG_BIN,

      timezone:
        TIMEZONE,

      nvr_time_semantics:
        "LOCAL_WIB_WITH_Z_SUFFIX",

      features: {

        search:
          true,

        stream:
          true,

        download:
          true,

        playback_uri_from_isapi:
          true

      }

    });

  }
);


/* ============================================================
   BASIC HELPERS
   ============================================================ */

function getTrackId(
  camera
) {

  return (
    camera * 100 + 1
  );

}


function validateDate(
  date
) {

  if (
    !/^\d{4}-\d{2}-\d{2}$/
      .test(date)
  ) {

    return false;

  }


  const parsed =
    new Date(
      `${date}T00:00:00+07:00`
    );


  return !Number.isNaN(
    parsed.getTime()
  );

}


function validateTime(
  time
) {

  if (
    !/^\d{2}:\d{2}(:\d{2})?$/
      .test(time)
  ) {

    return false;

  }


  const parts =
    time
      .split(":")
      .map(Number);


  const hour =
    parts[0];

  const minute =
    parts[1];

  const second =
    parts[2] ??
    0;


  return (

    hour >= 0 &&
    hour <= 23 &&

    minute >= 0 &&
    minute <= 59 &&

    second >= 0 &&
    second <= 59

  );

}


function normalizeTime(
  time
) {

  if (
    time.length === 5
  ) {

    return (
      `${time}:00`
    );

  }


  return time;

}


/* ============================================================
   HIKVISION LOCAL-TIME FORMAT
   ============================================================ */

function formatIsapiLocal(
  date,
  time
) {

  const normalized =
    normalizeTime(
      time
    );


  /*
   * Sengaja memakai suffix Z tanpa konversi UTC.
   *
   * 10:50 WIB -> 10:50:00Z
   */

  return (
    `${date}T${normalized}Z`
  );

}


function formatRtspLocal(
  date,
  time
) {

  const normalized =
    normalizeTime(
      time
    );


  const compactDate =
    date.replaceAll(
      "-",
      ""
    );


  const compactTime =
    normalized.replaceAll(
      ":",
      ""
    );


  return (
    `${compactDate}T${compactTime}Z`
  );

}


/* ============================================================
   DATE RANGES
   ============================================================ */

function createDayRange(
  date
) {

  return {

    startIsapi:
      `${date}T00:00:00Z`,

    endIsapi:
      `${date}T23:59:59Z`

  };

}


function createPlaybackRange(
  date,
  startTime,
  endTime
) {

  startTime =
    normalizeTime(
      startTime
    );


  endTime =
    normalizeTime(
      endTime
    );


  /*
   * Date +07:00 hanya dipakai menghitung DURASI.
   * Tidak dipakai membentuk timestamp ISAPI.
   */

  const startDate =
    new Date(
      `${date}T${startTime}+07:00`
    );


  const endDate =
    new Date(
      `${date}T${endTime}+07:00`
    );


  if (
    Number.isNaN(
      startDate.getTime()
    ) ||
    Number.isNaN(
      endDate.getTime()
    )
  ) {

    throw new Error(
      "Tanggal atau jam tidak valid"
    );

  }


  if (
    endDate <=
    startDate
  ) {

    throw new Error(
      "Jam selesai harus setelah jam mulai"
    );

  }


  const durationSeconds =
    Math.floor(
      (
        endDate.getTime() -
        startDate.getTime()
      ) /
      1000
    );


  if (
    durationSeconds <= 0
  ) {

    throw new Error(
      "Durasi playback tidak valid"
    );

  }


  if (
    durationSeconds >
    86400
  ) {

    throw new Error(
      "Rentang maksimum 24 jam"
    );

  }


  return {

    date,

    startTime,

    endTime,

    durationSeconds,

    isapiStart:
      formatIsapiLocal(
        date,
        startTime
      ),

    isapiEnd:
      formatIsapiLocal(
        date,
        endTime
      ),

    rtspStart:
      formatRtspLocal(
        date,
        startTime
      ),

    rtspEnd:
      formatRtspLocal(
        date,
        endTime
      )

  };

}


/* ============================================================
   HIKVISION TIME DISPLAY
   ============================================================ */

function formatHikvisionLocal(
  value
) {

  if (
    !value
  ) {

    return null;

  }


  /*
   * Jangan new Date(value) lalu convert ke Jakarta.
   *
   * "2026-09-15T10:40:22Z"
   * pada NVR ini berarti 10:40:22 WIB.
   */

  const match =
    String(value)
      .match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z$/
      );


  if (
    !match
  ) {

    return String(value);

  }


  return (
    `${match[1]} ${match[2]}`
  );

}


/* ============================================================
   PSEUDO TIME FOR COMPARISON
   ============================================================ */

function pseudoTimeMs(
  value
) {

  if (
    !value
  ) {

    return NaN;

  }


  /*
   * Kita hanya perlu membandingkan angka timestamp Hikvision.
   * Semua timestamp memakai basis pseudo-Z yang sama.
   */

  return new Date(
    value
  ).getTime();

}


/* ============================================================
   BUILD SEARCH XML
   ============================================================ */

function buildSearchXml(
  camera,
  startIsapi,
  endIsapi
) {

  const track =
    getTrackId(
      camera
    );


  /*
   * trackList dan searchResultPostion sengaja mengikuti
   * payload asli web Hikvision firmware ini.
   */

  return `
<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${randomUUID()}</searchID>
  <trackList>
    <trackID>${track}</trackID>
  </trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>${startIsapi}</startTime>
      <endTime>${endIsapi}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>100</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>
`.trim();

}


/* ============================================================
   RUN ISAPI SEARCH
   ============================================================ */

async function runIsapiSearch(
  xml
) {

  const tempFile =
    `/tmp/hik-search-${process.pid}-${Date.now()}.xml`;


  const url =
    `http://${NVR_HOST}` +
    `/ISAPI/ContentMgmt/search`;


  await writeFile(
    tempFile,
    xml,
    "utf8"
  );


  try {

    return await new Promise(
      (
        resolve,
        reject
      ) => {

        const curl =
          spawn(
            "curl",
            [

              "-sS",

              "--anyauth",

              "-u",
              `${NVR_USERNAME}:${NVR_PASSWORD}`,

              "--connect-timeout",
              "5",

              "--max-time",
              "30",

              "-H",
              "Content-Type: application/xml",

              "-X",
              "POST",

              "--data-binary",
              `@${tempFile}`,

              url

            ],
            {

              stdio: [
                "ignore",
                "pipe",
                "pipe"
              ]

            }
          );


        let stdout =
          "";

        let stderr =
          "";


        curl.stdout.on(
          "data",
          chunk => {

            stdout +=
              chunk.toString();

          }
        );


        curl.stderr.on(
          "data",
          chunk => {

            stderr +=
              chunk.toString();

          }
        );


        curl.on(
          "error",
          error => {

            reject(
              new Error(
                `Gagal menjalankan curl: ${error.message}`
              )
            );

          }
        );


        curl.on(
          "close",
          code => {

            if (
              code !== 0
            ) {

              return reject(
                new Error(
                  stderr.trim() ||
                  `curl exit ${code}`
                )
              );

            }


            if (
              !stdout.trim()
            ) {

              return reject(
                new Error(
                  "NVR memberi response kosong"
                )
              );

            }


            resolve(
              stdout
            );

          }
        );

      }
    );

  }

  finally {

    await unlink(
      tempFile
    )
      .catch(
        () => {}
      );

  }

}


/* ============================================================
   SEARCH PARSER
   ============================================================ */

function normalizeMatches(
  matches
) {

  if (
    !matches
  ) {

    return [];

  }


  return Array.isArray(
    matches
  )
    ? matches
    : [matches];

}


function parseSearchResponse(
  rawXml,
  track
) {

  const parsed =
    xmlParser.parse(
      rawXml
    );


  const result =
    parsed
      ?.CMSearchResult;


  if (
    !result
  ) {

    throw new Error(
      "Response NVR bukan CMSearchResult"
    );

  }


  if (
    String(
      result.responseStatus ??
      ""
    )
      .toLowerCase() !==
    "true"
  ) {

    throw new Error(

      result.responseStatusStrg ||

      "NVR menolak pencarian"

    );

  }


  const matches =
    normalizeMatches(
      result
        ?.matchList
        ?.searchMatchItem
    );


  const recordings =
    matches.map(
      (
        item,
        index
      ) => {

        const descriptor =
          item
            ?.mediaSegmentDescriptor ??
          {};


        const startRaw =
          item
            ?.timeSpan
            ?.startTime ??
          null;


        const endRaw =
          item
            ?.timeSpan
            ?.endTime ??
          null;


        let recordingName =
          null;

        let sizeBytes =
          null;


        let playbackURI =
          descriptor
            ?.playbackURI ??
          null;


        if (
          playbackURI
        ) {

          playbackURI =
            String(
              playbackURI
            )
              .replaceAll(
                "&amp;",
                "&"
              );


          try {

            const uri =
              new URL(
                playbackURI
              );


            recordingName =
              uri.searchParams.get(
                "name"
              );


            const size =
              Number(
                uri.searchParams.get(
                  "size"
                )
              );


            if (
              Number.isFinite(
                size
              )
            ) {

              sizeBytes =
                size;

            }

          }

          catch {

          }

        }


        const metadata =
          item
            ?.metadataMatches
            ?.metadataDescriptor ??
          null;


        return {

          id:
            index,

          track:
            Number(
              item.trackID ??
              track
            ),

          start_raw:
            startRaw,

          end_raw:
            endRaw,

          start_local:
            formatHikvisionLocal(
              startRaw
            ),

          end_local:
            formatHikvisionLocal(
              endRaw
            ),

          content_type:
            descriptor
              ?.contentType ??
            null,

          codec:
            descriptor
              ?.codecType ??
            null,

          recording_type:
            metadata,

          recording_name:
            recordingName,

          size_bytes:
            sizeBytes,

          playback_uri:
            playbackURI

        };

      }
    );


  return {

    status:
      result.responseStatusStrg ??
      null,

    dvrMatches:
      Number(
        result.numOfMatches ??
        recordings.length
      ),

    recordings

  };

}


/* ============================================================
   SEARCH RECORDING
   ============================================================ */

async function searchRecording(
  camera,
  startIsapi,
  endIsapi
) {

  const xml =
    buildSearchXml(
      camera,
      startIsapi,
      endIsapi
    );


  const raw =
    await runIsapiSearch(
      xml
    );


  return parseSearchResponse(
    raw,
    getTrackId(
      camera
    )
  );

}


/* ============================================================
   FIND START SEGMENT
   ============================================================ */

function findStartingRecording(
  recordings,
  requestedStart
) {

  const target =
    pseudoTimeMs(
      requestedStart
    );


  if (
    Number.isNaN(
      target
    )
  ) {

    return null;

  }


  /*
   * Prioritas:
   * segmen yang benar-benar mencakup jam mulai.
   */

  const containing =
    recordings.find(
      recording => {

        const start =
          pseudoTimeMs(
            recording.start_raw
          );

        const end =
          pseudoTimeMs(
            recording.end_raw
          );


        return (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          target >= start &&
          target < end
        );

      }
    );


  if (
    containing
  ) {

    return containing;

  }


  /*
   * Fallback ke segmen pertama yang overlap.
   */

  return recordings[0] ??
    null;

}


/* ============================================================
   BUILD PLAYBACK URL FROM REAL ISAPI playbackURI
   ============================================================ */

function buildPlaybackUrl(
  recording,
  range
) {

  if (
    !recording
      ?.playback_uri
  ) {

    throw new Error(
      "NVR tidak memberikan playbackURI"
    );

  }


  let uri;


  try {

    uri =
      new URL(
        recording.playback_uri
      );

  }

  catch {

    throw new Error(
      "playbackURI dari NVR tidak valid"
    );

  }


  /*
   * playbackURI dari ISAPI tidak membawa credential.
   */

  uri.username =
    NVR_USERNAME;

  uri.password =
    NVR_PASSWORD;

  uri.hostname =
    NVR_HOST;

  uri.port =
    String(
      NVR_RTSP_PORT
    );


  /*
   * Gunakan jam pilihan user.
   *
   * name dan size dari playbackURI asli TETAP dipertahankan.
   */

  uri.searchParams.set(
    "starttime",
    range.rtspStart
  );

  uri.searchParams.set(
    "endtime",
    range.rtspEnd
  );


  return uri.toString();

}


/* ============================================================
   FFMPEG ARGUMENT
   ============================================================ */

function buildFfmpegArgs(
  playbackUrl,
  durationSeconds
) {

  return [

    "-hide_banner",

    "-loglevel",
    "warning",

    "-rtsp_transport",
    "tcp",

    "-fflags",
    "+genpts",

    "-i",
    playbackUrl,

    /*
     * NVR terbukti tidak selalu berhenti di endtime.
     * FFmpeg yang memaksa durasi.
     */

    "-t",
    String(
      durationSeconds
    ),

    "-map",
    "0:v:0",

    "-map",
    "0:a?",

    /*
     * Video tidak encode ulang.
     */

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-pix_fmt",
    "yuv420p",

    /*
     * G711 / PCM -> AAC untuk MP4/browser.
     */

    "-c:a",
    "aac",

    "-b:a",
    "48k",

    "-avoid_negative_ts",
    "make_zero",

    /*
     * Fragmented MP4 agar bisa langsung di-stream.
     */

    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",

    "-f",
    "mp4",

    "pipe:1"

  ];

}


/* ============================================================
   HLS SESSION HELPERS
   ============================================================ */

async function prepareHlsSession(
  requestId
) {

  const sessionDir =
    `${HLS_PLAYBACK_ROOT}/${requestId}`;

  const playlistPath =
    `${sessionDir}/index.m3u8`;

  const segmentPattern =
    `${sessionDir}/segment_%05d.ts`;


  /*
   * Bersihkan sisa session dengan ID sama kalau ada.
   * Secara normal UUID tidak akan bentrok, tapi hidup sudah
   * cukup aneh tanpa bergantung pada "harusnya".
   */
  await rm(
    sessionDir,
    {
      recursive: true,
      force: true
    }
  );


  await mkdir(
    sessionDir,
    {
      recursive: true
    }
  );


  return {
    sessionDir,
    playlistPath,
    segmentPattern
  };

}


async function cleanupHlsSession(
  sessionDir
) {

  if (!sessionDir) {
    return;
  }


  try {

    await rm(
      sessionDir,
      {
        recursive: true,
        force: true
      }
    );

  }

  catch (error) {

    console.error(
      "[HLS CLEANUP ERROR]",
      error.message
    );

  }

}


async function waitForHlsPlaylist(
  playlistPath,
  child,
  timeoutMs = 15000
) {

  const started =
    Date.now();


  while (
    Date.now() - started <
    timeoutMs
  ) {

    try {

      await access(
        playlistPath
      );

      return true;

    }

    catch {
      // Belum dibuat FFmpeg.
    }


    if (
      child.exitCode !== null ||
      child.signalCode !== null
    ) {

      return false;

    }


    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          200
        )
    );

  }


  return false;

}


function scheduleHlsCleanup(
  sessionDir,
  delayMs = 120000
) {

  if (!sessionDir) {
    return;
  }


  const timer =
    setTimeout(
      () => {

        cleanupHlsSession(
          sessionDir
        );

      },
      delayMs
    );


  if (
    typeof timer.unref ===
    "function"
  ) {

    timer.unref();

  }

}


async function getDirectorySize(
  dirPath
) {

  let total =
    0;


  const entries =
    await readdir(
      dirPath,
      {
        withFileTypes: true
      }
    );


  for (const entry of entries) {

    const fullPath =
      `${dirPath}/${entry.name}`;


    if (entry.isDirectory()) {

      total +=
        await getDirectorySize(
          fullPath
        );

    }

    else if (entry.isFile()) {

      const info =
        await stat(
          fullPath
        );


      total +=
        info.size;

    }

  }


  return total;

}


async function enforceHlsCacheLimit() {

  await mkdir(
    HLS_PLAYBACK_ROOT,
    {
      recursive: true
    }
  );


  const entries =
    await readdir(
      HLS_PLAYBACK_ROOT,
      {
        withFileTypes: true
      }
    );


  const sessions =
    [];


  for (const entry of entries) {

    if (!entry.isDirectory()) {
      continue;
    }


    const sessionDir =
      `${HLS_PLAYBACK_ROOT}/${entry.name}`;


    /*
     * Jangan sentuh session yang sedang aktif.
     */
    if (
      activePlayback &&
      activePlayback.sessionDir === sessionDir
    ) {

      continue;

    }


    try {

      const info =
        await stat(
          sessionDir
        );


      const ageMs =
        Date.now() -
        info.mtimeMs;


      if (
        ageMs >=
        HLS_RETENTION_MS
      ) {

        console.log(
          `[HLS CACHE EXPIRE] ${entry.name}`
        );


        await rm(
          sessionDir,
          {
            recursive: true,
            force: true
          }
        );


        continue;

      }


      const size =
        await getDirectorySize(
          sessionDir
        );


      sessions.push({
        name:
          entry.name,

        path:
          sessionDir,

        mtimeMs:
          info.mtimeMs,

        size
      });

    }

    catch (error) {

      console.error(
        "[HLS CACHE SCAN ERROR]",
        entry.name,
        error.message
      );

    }

  }


  let totalBytes =
    sessions.reduce(
      (
        sum,
        session
      ) =>
        sum +
        session.size,

      0
    );


  if (
    totalBytes <=
    HLS_CACHE_MAX_BYTES
  ) {

    return;

  }


  /*
   * Cache kepenuhan:
   * hapus session paling tua sampai kembali <= 5 GB.
   */
  sessions.sort(
    (
      a,
      b
    ) =>
      a.mtimeMs -
      b.mtimeMs
  );


  for (const session of sessions) {

    if (
      totalBytes <=
      HLS_CACHE_MAX_BYTES
    ) {

      break;

    }


    console.log(
      `[HLS CACHE EVICT] ${session.name}`
    );


    await rm(
      session.path,
      {
        recursive: true,
        force: true
      }
    );


    totalBytes -=
      session.size;

  }

}


/* ============================================================
   FFMPEG ARGUMENT - HLS PLAYBACK
   ============================================================ */

function buildHlsFfmpegArgs(
  playbackUrl,
  durationSeconds,
  playlistPath,
  segmentPattern
) {

  return [

    "-hide_banner",

    "-loglevel",
    "warning",

    "-nostdin",

    "-rtsp_transport",
    "tcp",

    "-fflags",
    "+genpts",

    "-i",
    playbackUrl,

    /*
     * NVR kadang mengabaikan endtime RTSP.
     * Durasi tetap dipaksa FFmpeg.
     */
    "-t",
    String(
      durationSeconds
    ),

    "-map",
    "0:v:0",

    "-map",
    "0:a?",

    /*
     * HEVC/H.265 NVR -> H.264 browser-compatible.
     */
    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-pix_fmt",
    "yuv420p",

    /*
     * Paksa keyframe tiap ~1 detik supaya segment HLS
     * benar-benar pendek dan startup playback cepat.
     */
    "-force_key_frames",
    "expr:gte(t,n_forced*1)",

    /*
     * Audio NVR -> AAC browser-compatible.
     */
    "-c:a",
    "aac",

    "-b:a",
    "48k",

    "-avoid_negative_ts",
    "make_zero",

    /*
     * HLS khusus recording playback.
     * BUKAN live CCTV.
     */
    "-f",
    "hls",

    "-hls_time",
    "1",

    "-hls_list_size",
    "0",

    "-hls_flags",
    "independent_segments+temp_file",

    "-hls_segment_filename",
    segmentPattern,

    playlistPath

  ];

}


/* ============================================================
   VALIDATE PLAYBACK QUERY
   ============================================================ */

function getPlaybackRequest(
  req
) {

  const camera =
    Number(
      req.query.camera
    );


  const date =
    String(
      req.query.date ||
      ""
    ).trim();


  const start =
    String(
      req.query.start ||
      ""
    ).trim();


  const end =
    String(
      req.query.end ||
      ""
    ).trim();


  if (
    !Number.isInteger(
      camera
    ) ||
    camera < 1 ||
    camera > 8
  ) {

    throw new Error(
      "Camera harus antara 1 sampai 8"
    );

  }


  if (
    !validateDate(
      date
    )
  ) {

    throw new Error(
      "Tanggal tidak valid"
    );

  }


  if (
    !validateTime(
      start
    ) ||
    !validateTime(
      end
    )
  ) {

    throw new Error(
      "Jam harus HH:MM atau HH:MM:SS"
    );

  }


  const range =
    createPlaybackRange(
      date,
      start,
      end
    );


  return {

    camera,
    date,
    start,
    end,
    range

  };

}


/* ============================================================
   SEARCH API
   ============================================================ */

app.get(
  "/api/playback/search",
  async (
    req,
    res
  ) => {

    try {

      const camera =
        Number(
          req.query.camera
        );


      const date =
        String(
          req.query.date ||
          ""
        ).trim();


      if (
        !Number.isInteger(
          camera
        ) ||
        camera < 1 ||
        camera > 8
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Camera harus antara 1 sampai 8"

          });

      }


      if (
        !validateDate(
          date
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Tanggal harus YYYY-MM-DD"

          });

      }


      const range =
        createDayRange(
          date
        );


      const result =
        await searchRecording(
          camera,
          range.startIsapi,
          range.endIsapi
        );


      return res.json({

        success:
          true,

        available:
          result.recordings.length >
          0,

        camera,

        track:
          getTrackId(
            camera
          ),

        date,

        timezone:
          TIMEZONE,

        nvr_time_semantics:
          "LOCAL_WIB_WITH_Z_SUFFIX",

        dvr_matches:
          result.dvrMatches,

        count:
          result.recordings.length,

        recordings:
          result.recordings

      });

    }

    catch (
      error
    ) {

      console.error(
        "[SEARCH ERROR]",
        error.message
      );


      return res
        .status(500)
        .json({

          success:
            false,

          error:
            "Gagal mencari recording",

          details:
            error.message

        });

    }

  }
);


/* ============================================================
   PLAYBACK HELPERS
   ============================================================ */

function redactPlaybackText(value) {

  let text =
    String(value || "");


  const secrets = [
    NVR_PASSWORD,

    NVR_PASSWORD
      ? encodeURIComponent(
          NVR_PASSWORD
        )
      : "",

    (
      NVR_USERNAME &&
      NVR_PASSWORD
    )
      ? `${NVR_USERNAME}:${NVR_PASSWORD}`
      : "",

    (
      NVR_USERNAME &&
      NVR_PASSWORD
    )
      ? `${NVR_USERNAME}:${encodeURIComponent(NVR_PASSWORD)}`
      : ""
  ].filter(Boolean);


  for (const secret of secrets) {

    text =
      text
        .split(secret)
        .join("***");

  }


  text =
    text.replace(
      /(rtsp:\/\/)([^@\s]+)@/gi,
      "$1***:***@"
    );


  return text;

}


function releasePlaybackLock(requestId) {

  if (
    activePlayback &&
    activePlayback.id === requestId
  ) {

    console.log(
      `[PLAYBACK LOCK RELEASE] ${requestId}`
    );

    activePlayback =
      null;

  }

}


function stopPlaybackProcess(
  child,
  reason
) {

  if (!child) {
    return;
  }


  if (
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }


  /*
   * Satu proses hanya boleh masuk prosedur stop sekali.
   * request-aborted dan response-close bisa terjadi hampir bersamaan.
   */
  if (child.__playbackStopRequested) {
    return;
  }


  child.__playbackStopRequested =
    true;


  console.warn(
    `[PLAYBACK STOP] pid=${child.pid || "-"} reason=${reason}`
  );


  try {

    child.kill(
      "SIGTERM"
    );

  }

  catch (error) {

    console.error(
      "[PLAYBACK SIGTERM ERROR]",
      error.message
    );

  }


  const forceKillTimer =
    setTimeout(
      () => {

        if (
          child.exitCode === null &&
          child.signalCode === null
        ) {

          console.warn(
            `[PLAYBACK FORCE KILL] pid=${child.pid || "-"}`
          );


          try {

            child.kill(
              "SIGKILL"
            );

          }

          catch (error) {

            console.error(
              "[PLAYBACK SIGKILL ERROR]",
              error.message
            );

          }

        }

      },
      PLAYBACK_KILL_GRACE_MS
    );


  /*
   * Kalau FFmpeg sudah mati normal setelah SIGTERM,
   * batalkan timer SIGKILL.
   */
  child.once(
    "close",
    () => {

      clearTimeout(
        forceKillTimer
      );

    }
  );


  if (
    typeof forceKillTimer.unref ===
    "function"
  ) {

    forceKillTimer.unref();

  }

}


/* ============================================================
   SEND RECORDING
   ============================================================ */

async function sendRecording(
  req,
  res,
  download
) {

  let ffmpeg =
    null;

  let requestId =
    null;

  let responseStarted =
    false;

  let stderr =
    "";

  let startupTimer =
    null;

  let stallTimer =
    null;

  let clientDisconnected =
    false;


  function clearPlaybackTimers() {

    if (startupTimer) {

      clearTimeout(
        startupTimer
      );

      startupTimer =
        null;

    }


    if (stallTimer) {

      clearTimeout(
        stallTimer
      );

      stallTimer =
        null;

    }

  }


  function armStallTimer() {

    if (stallTimer) {

      clearTimeout(
        stallTimer
      );

    }


    stallTimer =
      setTimeout(
        () => {

          console.error(
            `[PLAYBACK STALL TIMEOUT] request=${requestId}`
          );


          if (
            !res.headersSent
          ) {

            res
              .status(504)
              .json({
                success: false,
                error:
                  "Playback berhenti merespons"
              });

          }


          stopPlaybackProcess(
            ffmpeg,
            "stall-timeout"
          );

        },
        PLAYBACK_STALL_TIMEOUT_MS
      );


    if (
      typeof stallTimer.unref ===
      "function"
    ) {

      stallTimer.unref();

    }

  }


  try {

    const playback =
      getPlaybackRequest(
        req
      );


    const {
      camera,
      date,
      start,
      end,
      range
    } = playback;


    /*
     * Maksimal satu playback RTSP.
     * Search ISAPI tidak memakai session RTSP,
     * tetapi request kedua tetap kita tolak cepat.
     */
    if (activePlayback) {

      return res
        .status(409)
        .json({
          success: false,
          error:
            "Playback lain masih aktif"
        });

    }


    /* ========================================================
       SEARCH RECORDING
       ======================================================== */

    const search =
      await searchRecording(
        camera,
        range.isapiStart,
        range.isapiEnd
      );


    if (
      req.aborted ||
      res.destroyed
    ) {

      return;

    }


    if (
      search.recordings.length === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          error:
            "Tidak ada recording pada rentang tersebut"
        });

    }


    const recording =
      findStartingRecording(
        search.recordings,
        range.isapiStart
      );


    if (!recording) {

      return res
        .status(404)
        .json({
          success: false,
          error:
            "Segmen recording tidak ditemukan"
        });

    }


    if (!recording.playback_uri) {

      return res
        .status(502)
        .json({
          success: false,
          error:
            "NVR tidak memberikan playbackURI"
        });

    }


    /*
     * Search memakai await.
     * Cek lagi untuk menutup race dua request bersamaan.
     */
    if (activePlayback) {

      return res
        .status(409)
        .json({
          success: false,
          error:
            "Playback lain masih aktif"
        });

    }


    /* ========================================================
       LOCK PLAYBACK
       ======================================================== */

    requestId =
      randomUUID();


    activePlayback = {
      id:
        requestId,

      camera,

      mode:
        download
          ? "download"
          : "stream",

      started_at:
        new Date()
          .toISOString(),

      ffmpeg:
        null
    };


    console.log(
      `[PLAYBACK LOCK] ${requestId}`
    );


    const playbackUrl =
      buildPlaybackUrl(
        recording,
        range
      );


    const filename =
      `CAM${camera}_` +
      `${date}_` +
      `${normalizeTime(start).replaceAll(":", "")}-` +
      `${normalizeTime(end).replaceAll(":", "")}.mp4`;


    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      download
        ? "[DOWNLOAD]"
        : "[STREAM]"
    );

    console.log(
      `REQUEST  : ${requestId}`
    );

    console.log(
      `CAM      : ${camera}`
    );

    console.log(
      `TRACK    : ${getTrackId(camera)}`
    );

    console.log(
      `DATE     : ${date}`
    );

    console.log(
      `START    : ${normalizeTime(start)} WIB`
    );

    console.log(
      `END      : ${normalizeTime(end)} WIB`
    );

    console.log(
      `DURATION : ${range.durationSeconds} sec`
    );

    console.log(
      `MATCHES  : ${search.recordings.length}`
    );

    console.log(
      `SEGMENT  : ${recording.start_local} -> ${recording.end_local}`
    );

    console.log(
      `NAME     : ${recording.recording_name || "-"}`
    );

    console.log(
      "========================================"
    );

    console.log("");


    /* ========================================================
       START FFMPEG
       ======================================================== */

    ffmpeg =
      spawn(
        FFMPEG_BIN,

        buildFfmpegArgs(
          playbackUrl,
          range.durationSeconds
        ),

        {
          stdio: [
            "ignore",
            "pipe",
            "pipe"
          ]
        }
      );


    activePlayback.ffmpeg =
      ffmpeg;


    /* ========================================================
       STARTUP TIMEOUT
       ======================================================== */

    startupTimer =
      setTimeout(
        () => {

          if (
            responseStarted ||
            clientDisconnected
          ) {
            return;
          }


          console.error(
            `[PLAYBACK START TIMEOUT] request=${requestId}`
          );


          if (
            !res.headersSent
          ) {

            res
              .status(504)
              .json({
                success: false,
                error:
                  "Timeout saat memulai playback NVR"
              });

          }


          stopPlaybackProcess(
            ffmpeg,
            "startup-timeout"
          );

        },
        PLAYBACK_START_TIMEOUT_MS
      );


    if (
      typeof startupTimer.unref ===
      "function"
    ) {

      startupTimer.unref();

    }


    /* ========================================================
       FFMPEG STDERR
       ======================================================== */

    ffmpeg.stderr.on(
      "data",
      chunk => {

        stderr +=
          chunk.toString();


        if (
          stderr.length > 12000
        ) {

          stderr =
            stderr.slice(
              -12000
            );

        }

      }
    );


    /* ========================================================
       FIRST MP4 DATA
       ======================================================== */

    ffmpeg.stdout.once(
      "data",
      firstChunk => {

        if (
          clientDisconnected ||
          res.destroyed
        ) {

          stopPlaybackProcess(
            ffmpeg,
            "client-gone-before-first-data"
          );

          return;

        }


        responseStarted =
          true;


        if (startupTimer) {

          clearTimeout(
            startupTimer
          );

          startupTimer =
            null;

        }


        ffmpeg.stdout.pause();


        res.status(
          200
        );


        res.setHeader(
          "Content-Type",
          "video/mp4"
        );


        /*
         * Endpoint ini stream sequential.
         * Jangan biarkan browser mengira ada byte-range file biasa.
         */
        res.setHeader(
          "Accept-Ranges",
          "none"
        );


        res.setHeader(
          "Content-Disposition",
          download
            ? `attachment; filename="${filename}"`
            : `inline; filename="${filename}"`
        );


        res.setHeader(
          "Cache-Control",
          "no-store"
        );


        res.setHeader(
          "X-Accel-Buffering",
          "no"
        );


        armStallTimer();


        ffmpeg.stdout.on(
          "data",
          armStallTimer
        );


        res.write(
          firstChunk
        );


        ffmpeg.stdout.pipe(
          res
        );


        ffmpeg.stdout.resume();

      }
    );


    /* ========================================================
       FFMPEG SPAWN ERROR
       ======================================================== */

    ffmpeg.on(
      "error",
      error => {

        clearPlaybackTimers();


        console.error(
          "[FFMPEG ERROR]",
          redactPlaybackText(
            error.message
          )
        );


        if (
          !responseStarted &&
          !res.headersSent
        ) {

          res
            .status(500)
            .json({
              success: false,
              error:
                "FFmpeg gagal dijalankan"
            });

        }


        if (!ffmpeg.pid) {

          releasePlaybackLock(
            requestId
          );

        }

      }
    );


    /* ========================================================
       FFMPEG CLOSE
       ======================================================== */

    ffmpeg.on(
      "close",
      (
        code,
        signal
      ) => {

        clearPlaybackTimers();


        console.log(
          `[${download ? "DOWNLOAD" : "STREAM"} END] ` +
          `CAM ${camera} ` +
          `code=${code} ` +
          `signal=${signal || "-"}`
        );


        /*
         * Detail hanya masuk journal/server.
         * Credential disensor.
         */
        if (stderr.trim()) {

          console.log(
            "[FFMPEG DETAIL]",
            redactPlaybackText(
              stderr.slice(
                -3000
              )
            )
          );

        }


        releasePlaybackLock(
          requestId
        );


        if (
          !responseStarted &&
          !res.headersSent &&
          !clientDisconnected
        ) {

          return res
            .status(502)
            .json({
              success: false,
              error:
                "Playback NVR gagal"
            });

        }


        if (
          !res.writableEnded &&
          !res.destroyed &&
          !clientDisconnected
        ) {

          res.end();

        }

      }
    );


    /* ========================================================
       CLIENT DISCONNECT
       ======================================================== */

    req.once(
      "aborted",
      () => {

        clientDisconnected =
          true;


        clearPlaybackTimers();


        stopPlaybackProcess(
          ffmpeg,
          "request-aborted"
        );

      }
    );


    res.once(
      "close",
      () => {

        /*
         * close normal setelah response selesai
         * tidak perlu kill lagi.
         */
        if (
          !res.writableEnded
        ) {

          clientDisconnected =
            true;


          clearPlaybackTimers();


          stopPlaybackProcess(
            ffmpeg,
            "response-closed"
          );

        }

      }
    );

  }


  catch (error) {

    clearPlaybackTimers();


    console.error(
      "[PLAYBACK ERROR]",
      redactPlaybackText(
        error.message
      )
    );


    if (
      ffmpeg &&
      ffmpeg.exitCode === null &&
      ffmpeg.signalCode === null
    ) {

      stopPlaybackProcess(
        ffmpeg,
        "exception"
      );

    }

    else if (requestId) {

      releasePlaybackLock(
        requestId
      );

    }


    if (
      !res.headersSent
    ) {

      return res
        .status(400)
        .json({
          success: false,
          error:
            "Permintaan playback gagal"
        });

    }

  }

}


/* ============================================================
   HLS PLAYBACK START
   ============================================================ */

async function startHlsPlayback(
  req,
  res
) {

  let ffmpeg =
    null;

  let requestId =
    null;

  let session =
    null;

  let stderr =
    "";


  try {

    const playback =
      getPlaybackRequest(
        req
      );


    const {
      camera,
      date,
      start,
      end,
      range
    } = playback;


    /*
     * NVR ini sensitif jumlah RTSP playback.
     * Jangan buka sesi kedua.
     */
    if (activePlayback) {

      return res
        .status(409)
        .json({
          success: false,
          error:
            "Playback lain masih aktif"
        });

    }


    const search =
      await searchRecording(
        camera,
        range.isapiStart,
        range.isapiEnd
      );


    if (
      req.aborted ||
      res.destroyed
    ) {

      return;

    }


    if (
      search.recordings.length === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          error:
            "Tidak ada recording pada rentang tersebut"
        });

    }


    const recording =
      findStartingRecording(
        search.recordings,
        range.isapiStart
      );


    if (!recording) {

      return res
        .status(404)
        .json({
          success: false,
          error:
            "Segmen recording tidak ditemukan"
        });

    }


    if (!recording.playback_uri) {

      return res
        .status(502)
        .json({
          success: false,
          error:
            "NVR tidak memberikan playbackURI"
        });

    }


    /*
     * Tutup race condition setelah await search.
     */
    if (activePlayback) {

      return res
        .status(409)
        .json({
          success: false,
          error:
            "Playback lain masih aktif"
        });

    }


    /*
     * Bersihkan cache expired / over-limit
     * sebelum membuat session HLS baru.
     */
    await enforceHlsCacheLimit();


    requestId =
      randomUUID();


    session =
      await prepareHlsSession(
        requestId
      );


    const playbackUrl =
      buildPlaybackUrl(
        recording,
        range
      );


    ffmpeg =
      spawn(
        FFMPEG_BIN,

        buildHlsFfmpegArgs(
          playbackUrl,
          range.durationSeconds,
          session.playlistPath,
          session.segmentPattern
        ),

        {
          stdio: [
            "ignore",
            "ignore",
            "pipe"
          ]
        }
      );


    activePlayback = {
      id:
        requestId,

      camera,

      mode:
        "hls",

      started_at:
        new Date()
          .toISOString(),

      ffmpeg,

      sessionDir:
        session.sessionDir
    };


    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "[HLS PLAYBACK]"
    );
    console.log(
      `REQUEST  : ${requestId}`
    );
    console.log(
      `CAM      : ${camera}`
    );
    console.log(
      `DATE     : ${date}`
    );
    console.log(
      `START    : ${normalizeTime(start)} WIB`
    );
    console.log(
      `END      : ${normalizeTime(end)} WIB`
    );
    console.log(
      `DURATION : ${range.durationSeconds} sec`
    );
    console.log(
      `SEGMENT  : ${recording.start_local} -> ${recording.end_local}`
    );
    console.log(
      "========================================"
    );
    console.log("");


    ffmpeg.stderr.on(
      "data",
      chunk => {

        stderr +=
          chunk.toString();


        if (
          stderr.length > 12000
        ) {

          stderr =
            stderr.slice(
              -12000
            );

        }

      }
    );


    ffmpeg.on(
      "error",
      error => {

        console.error(
          "[HLS FFMPEG ERROR]",
          redactPlaybackText(
            error.message
          )
        );


        if (!ffmpeg.pid) {

          releasePlaybackLock(
            requestId
          );

          scheduleHlsCleanup(
            session.sessionDir,
            5000
          );

        }

      }
    );


    ffmpeg.on(
      "close",
      (
        code,
        signal
      ) => {

        console.log(
          `[HLS END] CAM ${camera} ` +
          `code=${code} ` +
          `signal=${signal || "-"}`
        );


        if (stderr.trim()) {

          console.log(
            "[HLS FFMPEG DETAIL]",
            redactPlaybackText(
              stderr.slice(
                -3000
              )
            )
          );

        }


        releasePlaybackLock(
          requestId
        );


        /*
         * Jangan langsung hapus.
         * Browser mungkin masih membaca segment terakhir.
         */
        scheduleHlsCleanup(
          session.sessionDir,
          43200000
        );

      }
    );


    /*
     * Tunggu sampai index.m3u8 benar-benar dibuat FFmpeg.
     * Browser tidak dikasih URL mati/404.
     */
    const ready =
      await waitForHlsPlaylist(
        session.playlistPath,
        ffmpeg,
        PLAYBACK_START_TIMEOUT_MS
      );


    if (!ready) {

      stopPlaybackProcess(
        ffmpeg,
        "hls-start-timeout"
      );


      scheduleHlsCleanup(
        session.sessionDir,
        5000
      );


      return res
        .status(504)
        .json({
          success: false,
          error:
            "HLS playback gagal mulai"
        });

    }


    return res
      .status(200)
      .json({
        success:
          true,

        mode:
          "hls",

        session_id:
          requestId,

        camera,

        duration_seconds:
          range.durationSeconds,

        playlist_url:
          `/api/playback/hls/files/${requestId}/index.m3u8`,

        stop_url:
          `/api/playback/hls/stop?session=${requestId}`
      });

  }

  catch (error) {

    console.error(
      "[HLS PLAYBACK ERROR]",
      redactPlaybackText(
        error.message
      )
    );


    if (
      ffmpeg &&
      ffmpeg.exitCode === null &&
      ffmpeg.signalCode === null
    ) {

      stopPlaybackProcess(
        ffmpeg,
        "hls-exception"
      );

    }


    if (
      requestId &&
      !ffmpeg
    ) {

      releasePlaybackLock(
        requestId
      );

    }


    if (session) {

      scheduleHlsCleanup(
        session.sessionDir,
        5000
      );

    }


    if (!res.headersSent) {

      return res
        .status(400)
        .json({
          success: false,
          error:
            "Permintaan HLS playback gagal"
        });

    }

  }

}


/* ============================================================
   HLS FILES
   ============================================================ */

app.use(
  "/api/playback/hls/files",

  express.static(
    HLS_PLAYBACK_ROOT,
    {
      fallthrough:
        true,

      setHeaders:
        response => {

          response.setHeader(
            "Cache-Control",
            "no-store"
          );

          response.setHeader(
            "Access-Control-Allow-Origin",
            "*"
          );

        }
    }
  )
);


/* ============================================================
   HLS START ROUTE
   ============================================================ */

app.get(
  "/api/playback/hls/start",
  (
    req,
    res
  ) => {

    return startHlsPlayback(
      req,
      res
    );

  }
);


/* ============================================================
   HLS STOP ROUTE
   ============================================================ */

app.get(
  "/api/playback/hls/stop",
  (
    req,
    res
  ) => {

    const sessionId =
      String(
        req.query.session ||
        ""
      ).trim();


    if (
      !activePlayback ||
      activePlayback.mode !== "hls"
    ) {

      return res
        .status(404)
        .json({
          success: false,
          error:
            "Tidak ada HLS playback aktif"
        });

    }


    if (
      !sessionId ||
      activePlayback.id !== sessionId
    ) {

      return res
        .status(409)
        .json({
          success: false,
          error:
            "Session playback tidak cocok"
        });

    }


    const process =
      activePlayback.ffmpeg;

    const sessionDir =
      activePlayback.sessionDir;


    stopPlaybackProcess(
      process,
      "hls-stop-request"
    );


    scheduleHlsCleanup(
      sessionDir,
      5000
    );


    return res
      .status(200)
      .json({
        success: true,
        message:
          "HLS playback dihentikan"
      });

  }
);


/* ============================================================
   STREAM
   ============================================================ */

app.get(
  "/api/playback/stream",
  (
    req,
    res
  ) => {

    return sendRecording(
      req,
      res,
      false
    );

  }
);


/* ============================================================
   DOWNLOAD
   ============================================================ */

app.get(
  "/api/playback/download",
  (
    req,
    res
  ) => {

    return sendRecording(
      req,
      res,
      true
    );

  }
);


/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        success:
          false,

        error:
          "Endpoint tidak ditemukan",

        path:
          req.path

      });

  }
);


/* ============================================================
   HLS CACHE PERIODIC MAINTENANCE
   ============================================================ */

const HLS_CACHE_MAINTENANCE_INTERVAL_MS =
  15 * 60 * 1000; // 15 menit


function runHlsCacheMaintenance() {

  enforceHlsCacheLimit()
    .catch(
      error => {

        console.error(
          "[HLS CACHE MAINTENANCE ERROR]",
          error.message
        );

      }
    );

}


/*
 * Sweep awal beberapa detik setelah service hidup.
 */
const hlsInitialCleanupTimer =
  setTimeout(
    runHlsCacheMaintenance,
    5000
  );


if (
  typeof hlsInitialCleanupTimer.unref ===
  "function"
) {

  hlsInitialCleanupTimer.unref();

}


/*
 * Setelah itu rawat cache setiap 15 menit.
 */
const hlsCacheMaintenanceTimer =
  setInterval(
    runHlsCacheMaintenance,
    HLS_CACHE_MAINTENANCE_INTERVAL_MS
  );


if (
  typeof hlsCacheMaintenanceTimer.unref ===
  "function"
) {

  hlsCacheMaintenanceTimer.unref();

}


/* ============================================================
   START
   ============================================================ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      " CCTV PLAYBACK API"
    );

    console.log(
      "========================================"
    );

    console.log(
      `PORT       : ${PORT}`
    );

    console.log(
      `NVR HOST   : ${NVR_HOST}`
    );

    console.log(
      `RTSP PORT  : ${NVR_RTSP_PORT}`
    );

    console.log(
      `USERNAME   : ${
        NVR_USERNAME
          ? "SET"
          : "NOT SET"
      }`
    );

    console.log(
      `PASSWORD   : ${
        NVR_PASSWORD
          ? "SET"
          : "NOT SET"
      }`
    );

    console.log(
      `FFMPEG     : ${FFMPEG_BIN}`
    );

    console.log(
      `TIMEZONE   : ${TIMEZONE}`
    );

    console.log(
      "NVR TIME   : LOCAL WIB + Z"
    );

    console.log(
      "SEARCH API   : ENABLED"
    );

    console.log(
      "STREAM API   : ENABLED"
    );

    console.log(
      "DOWNLOAD API : ENABLED"
    );

    console.log(
      "========================================"
    );

    console.log("");

  }
);
