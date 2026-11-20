#!/usr/bin/env python3
"""Files GitHub issues from a QA findings.json (see HANDOFF.md).
Usage: dev/qa/file-issues.py <findings.json> <spec.json>
spec: {"<finding id>": {"title": "...", "img": [raw urls], "extra": "markdown", "skip": true}}"""
import json, subprocess, sys, re
findings = {f["id"]: f for f in json.load(open(sys.argv[1]))}
spec = json.load(open(sys.argv[2]))
def clean(s):  # drop local absolute paths
    return re.sub(r"/(?:tmp|home)/[^\s'\"`)]*?/(omega-qa-[\w-]+)", r"<\1>", s or "")
for fid, sp in spec.items():
    if sp.get("skip"): continue
    f = findings[fid]
    steps = "\n".join(f"{i+1}. {clean(s)}" for i, s in enumerate(f.get("steps", [])))
    body = f"## Description\n{clean(f.get('actual',''))}\n\n"
    if steps: body += f"## Steps to reproduce\n{steps}\n\n"
    body += f"## Expected\n{clean(f.get('expected',''))}\n\n"
    for u in sp.get("img", []): body += f"![screenshot]({u})\n\n"
    if f.get("suspected_code"): body += f"## Suspected cause\n{clean(f['suspected_code'])}\n\n"
    if sp.get("extra"): body += sp["extra"] + "\n\n"
    body += f"_Found by automated exploratory UI testing (dev/qa), {f.get('confidence','')}. Steps with `Q …` are control-MCP calls (`node dev/omega-mcp.mjs call <tool> <json>`)._\n"
    title = "[Bug] " + sp.get("title", f["title"])
    url = subprocess.run(["gh", "issue", "create", "-R", "philippeZim/Omega", "--title", title, "--body", body], capture_output=True, text=True)
    print(fid, url.stdout.strip() or url.stderr.strip())
