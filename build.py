import json, os, subprocess

os.environ["GOG_KEYRING_PASSWORD"] = "ace-aic-2026"

# Pull fresh data
r = subprocess.run(
    ["gog","sheets","get","1dHVNK3-YdnyBNoiVMcSuWJKy5oyWbIx6UdIa_w4XX_o",
     "Log!A1:T768","--account","ace-ai@peterszabo.co","--json"],
    capture_output=True, text=True, env={**os.environ}
)
appt = json.loads(r.stdout)
headers = appt["values"][0]
rows = appt["values"][1:]

# Build data.js
with open("/home/ubuntu/.openclaw/workspace/sm-dashboard/public/data.js","w") as f:
    f.write("const H=" + json.dumps(headers) + ";\n")
    f.write("const D=" + json.dumps(rows) + ";\n")

print(f"data.js: {len(rows)} rows")
