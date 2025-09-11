# scbot.py  —  Telegram bot cek proxy (kirim hanya TRUE)
import asyncio
import aiohttp
import aiofiles
import time
import os
from typing import List, Tuple
from telegram import Update, InputFile
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.request import HTTPXRequest
from colorama import init

init(autoreset=True)

# ====== KONFIGURASI ======
BOT_TOKEN = "8018446564:AAE9na2bRAXWZxdFmW_9h5Oy7iQvIwWN8aE"   # <-- GANTI

# Batas & timeout ke endpoint checker
CONCURRENCY = 80
LIMIT_PER_HOST = 40
TIMEOUT_SECS = 20
RETRIES = 3
BACKOFF_BASE = 0.8

# Timeout HTTPX ke Telegram (API + unduh file)
TG_CONNECT_TIMEOUT = 60.0
TG_READ_TIMEOUT    = 300.0   # besar supaya unduh file lambat tidak timeout
TG_WRITE_TIMEOUT   = 60.0
TG_POOL_TIMEOUT    = 60.0

# Long-poll di run_polling (jangan > 110)
LONGPOLL_TIMEOUT = 100
POLL_INTERVAL = 1.0

# Batas ukuran file input (opsional)
MAX_FILE_SIZE = 30 * 1024 * 1024  # 30 MB

# ====== UTIL ======
def parse_lines(raw: str) -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    seen = set()
    for line in raw.splitlines():
        s = line.strip().lstrip("\ufeff")
        if not s or "," not in s:
            continue
        parts = [p.strip() for p in s.split(",", 3)]
        if len(parts) != 4:
            continue
        ip, port, country, org = parts
        key = f"{ip},{port},{country},{org}"
        if key in seen:
            continue
        seen.add(key)
        out.append((ip, port, country, org))
    return out

def truthy_from_json(d: dict) -> bool:
    for k in ("proxyip", "ok", "valid", "alive", "result"):
        if k in d and isinstance(d[k], (bool, int)):
            return bool(d[k])
    val = str(d.get("status", "")).lower()
    return val in ("ok", "true", "alive", "valid")

# ====== Robust downloader file Telegram ======
async def download_telegram_file(file_obj, dest_path: str, max_retries: int = 3):
    """
    Unduh file Telegram via URL signed (file_obj.file_path) pakai aiohttp.
    Lebih tahan ReadTimeout dibanding download_to_drive default.
    """
    url = file_obj.file_path
    timeout = aiohttp.ClientTimeout(
        total=None,
        connect=TG_CONNECT_TIMEOUT,
        sock_connect=TG_CONNECT_TIMEOUT,
        sock_read=TG_READ_TIMEOUT,
    )
    for attempt in range(1, max_retries + 1):
        try:
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.get(url) as resp:
                    resp.raise_for_status()
                    async with aiofiles.open(dest_path, "wb") as f:
                        async for chunk in resp.content.iter_chunked(128 * 1024):
                            await f.write(chunk)
            return  # sukses
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if attempt >= max_retries:
                raise
            await asyncio.sleep(1.5 * attempt)

# ====== Checker ======
async def check_one(session: aiohttp.ClientSession, sem: asyncio.Semaphore,
                    ip: str, port: str, country: str, org: str) -> bool:
    url = f"https://proxyip.biz.id/{160.22.79.166}:{443}"
    attempt = 0
    while True:
        attempt += 1
        try:
            async with sem:
                async with session.get(url, timeout=TIMEOUT_SECS) as resp:
                    if resp.status in (429, 500, 502, 503, 504):
                        raise aiohttp.ClientResponseError(
                            request_info=resp.request_info,
                            history=resp.history,
                            status=resp.status,
                            message=f"retryable {resp.status}",
                            headers=resp.headers
                        )
                    data = await resp.json(content_type=None)
                    return truthy_from_json(data)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            if attempt <= (1 + RETRIES):
                await asyncio.sleep(BACKOFF_BASE * (2 ** (attempt - 1)))
                continue
            return False

async def process_proxies_to_truefile(lines, true_filepath, progress_cb=None) -> tuple[int,int]:
    # kosongkan file TRUE target
    open(true_filepath, "w").close()

    sem = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, limit_per_host=LIMIT_PER_HOST)
    timeout = aiohttp.ClientTimeout(
        total=None,
        connect=TIMEOUT_SECS,
        sock_connect=TIMEOUT_SECS,
        sock_read=TIMEOUT_SECS
    )

    q_true: asyncio.Queue[str] = asyncio.Queue()

    async def writer_true():
        async with aiofiles.open(true_filepath, "a", encoding="utf-8") as f:
            while True:
                line = await q_true.get()
                if line is None:
                    q_true.task_done()
                    break
                await f.write(line + "\n")
                q_true.task_done()

    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        total = len(lines)
        count_true = 0
        done = 0
        last_edit_ts = 0.0
        writer_task = asyncio.create_task(writer_true())

        async def worker(item_idx: int, ip: str, port: str, country: str, org: str):
            nonlocal count_true, done, last_edit_ts
            ok = await check_one(session, sem, ip, port, country, org)
            if ok:
                await q_true.put(f"{ip},{port},{country},{org}")
                count_true += 1
            done += 1

            now = time.monotonic()
            if progress_cb and (done % 10 == 0 or now - last_edit_ts >= 0.6 or done == total):
                last_edit_ts = now
                try:
                    await progress_cb(done, total, count_true)
                except Exception:
                    pass

        tasks = [worker(i, *t) for i, t in enumerate(lines)]
        await asyncio.gather(*tasks)

        await q_true.put(None)
        await writer_task
        return count_true, total

# ====== Telegram Handlers ======
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Kirim file .txt berisi baris: ip,port,country,org\n"
        "Bot akan mengecek dan mengirim balik hanya daftar yang TRUE."
    )

async def handle_txt_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    doc = update.message.document
    if not doc:
        return

    name = (doc.file_name or "").lower()
    if not name.endswith(".txt"):
        await update.message.reply_text("❌ Hanya menerima file .txt (format: ip,port,country,org).")
        return

    if getattr(doc, "file_size", 0) and doc.file_size > MAX_FILE_SIZE:
        await update.message.reply_text(f"❌ File terlalu besar (> {MAX_FILE_SIZE//(1024*1024)} MB).")
        return

    t0 = time.time()
    status = await update.message.reply_text("📥 Mengunduh file dari Telegram…")

    # ambil objek file + unduh manual (lebih tahan timeout jaringan)
    tg_file = await doc.get_file()
    in_path = f"in_{update.effective_user.id}_{int(t0)}.txt"

    try:
        await download_telegram_file(tg_file, in_path, max_retries=3)
    except Exception as e:
        await status.edit_text(f"❌ Gagal mengunduh file: {e}")
        return

    # baca & parse
    try:
        with open(in_path, "r", encoding="utf-8", errors="ignore") as f:
            raw = f.read()
    except Exception as e:
        await status.edit_text(f"❌ Gagal membaca file: {e}")
        try: os.remove(in_path)
        except: pass
        return

    items = parse_lines(raw)
    total = len(items)
    if total == 0:
        await status.edit_text("❌ Tidak ada baris valid (harus: ip,port,country,org).")
        try: os.remove(in_path)
        except: pass
        return

    await status.edit_text(f"🔄 Diterima {total} baris. Menyiapkan pengecekan…")

    async def progress_cb(done: int, total_: int, good: int):
        await status.edit_text(f"⏳ Mengecek proxy… {done}/{total_}\n✔ TRUE sementara: {good}")

    true_path = f"proxy-true_{update.effective_user.id}_{int(t0)}.txt"
    count_true, total_proc = await process_proxies_to_truefile(items, true_path, progress_cb)

    dur = time.time() - t0
    await status.edit_text(
        f"✅ Selesai {total_proc}/{total} dalam {dur:.2f}s.\n"
        f"✔ TRUE: {count_true}\n"
        f"📤 Mengirim file TRUE…"
    )

    try:
        if count_true > 0 and os.path.exists(true_path) and os.path.getsize(true_path) > 0:
            await update.message.reply_document(InputFile(true_path), caption=f"✔ TOTAL TRUE: {count_true}")
        else:
            await update.message.reply_text("Tidak ada proxy TRUE.")
    finally:
        for p in (in_path, true_path):
            try:
                if os.path.exists(p): os.remove(p)
            except: pass

# ====== MAIN ======
def main():
    # HTTPXRequest dengan timeout besar agar stabil di jaringan lambat
    request = HTTPXRequest(
        http_version="1.1",
        connect_timeout=TG_CONNECT_TIMEOUT,
        read_timeout=TG_READ_TIMEOUT,
        write_timeout=TG_WRITE_TIMEOUT,
        pool_timeout=TG_POOL_TIMEOUT,
        # butuh proxy? contoh:
        # proxies={"all://": "socks5://USER:PASS@HOST:PORT"}
        # proxies={"all://": "http://USER:PASS@HOST:PORT"}
    )

    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .request(request)
        .build()
    )

    app.add_handler(CommandHandler("start", start))
    # terima semua dokumen, filter .txt di handler (lebih andal dari MIME)
    app.add_handler(MessageHandler(filters.Document.ALL, handle_txt_file))

    app.run_polling(
        timeout=LONGPOLL_TIMEOUT,       # durasi long-poll per panggilan (≤110s)
        poll_interval=POLL_INTERVAL,
        drop_pending_updates=True
    )

if __name__ == "__main__":
    main()
