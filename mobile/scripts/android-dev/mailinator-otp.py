"""mailinator-otp.py <inbox> <since-epoch-seconds>: print the newest OpenKey 6-digit code sent to a
public mailinator inbox after <since>. For throwaway test accounts only; prints nothing else."""
import json, re, sys, time, urllib.request

inbox, since = sys.argv[1], int(sys.argv[2]) * 1000 - 30000
base = f"https://www.mailinator.com/api/v2/domains/public/inboxes/{inbox}"
for _ in range(40):
    try:
        msgs = json.load(urllib.request.urlopen(base)).get("msgs", [])
    except Exception:  # the public API blips (5xx); poll again
        time.sleep(3)
        continue
    fresh = sorted((m for m in msgs if m.get("time", 0) >= since and "OpenKey" in m.get("subject", "")), key=lambda m: -m["time"])
    if fresh:
        mid = fresh[0]["id"]
        for url in (f"{base}/messages/{mid}", f"https://www.mailinator.com/fetch_public?msgid={mid}"):
            try:
                body = urllib.request.urlopen(url).read().decode("utf-8", "replace")
            except Exception:
                continue
            m = re.search(r"(?<!\d)(\d{6})(?!\d)", re.sub(r"<[^>]+>", " ", body))
            if m:
                print(m.group(1))
                sys.exit(0)
    time.sleep(3)
sys.exit("no code")
