#!/usr/bin/env python3
import argparse, json, os, secrets, time
from datetime import datetime, timezone

INTENT_DIR = "governance/alteration-program/intent"

def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00","Z")

def new_intent_id():
    ms = int(time.time() * 1000)
    return f"{ms}-{secrets.token_hex(4)}"

def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def cmd_init(a):
    iid = new_intent_id()
    obj = {
      "intentId": iid,
      "title": a.title,
      "system": a.system,
      "changeClass": a.change_class,
      "scope": {"in": a.scope_in, "out": a.scope_out},
      "riskClass": a.risk,
      "governanceImpact": a.gov,
      "actorId": a.actor,
      "createdAt": now(),
      "status": "draft",
      "verification": {"plan": a.verify_plan, "requiredChecks": a.required_checks},
      "evidence": {"required": bool(a.gov), "receiptRefs": [], "notes": a.evidence_notes},
      "amendments": []
    }
    path = os.path.join(INTENT_DIR, f"{iid}.json")
    write_json(path, obj)
    print(path)
    print(f"IntentId: {iid}")

def cmd_amend(a):
    obj = load_json(a.intent)
    obj.setdefault("amendments", [])
    obj["amendments"].append({
      "amendedAt": now(),
      "actorId": a.actor,
      "reason": a.reason,
      "fieldsChanged": a.fields_changed
    })
    write_json(a.intent, obj)
    print(f"Amended: {a.intent}")

def cmd_close(a):
    obj = load_json(a.intent)
    if obj.get("status") == "closed":
        print("Already closed.")
        return
    if obj.get("governanceImpact") and not a.receipt_refs:
        raise SystemExit("Fail-closed: governanceImpact=true requires --receipt-ref at close.")
    obj["status"] = "closed"
    obj.setdefault("evidence", {}).setdefault("receiptRefs", [])
    for rr in a.receipt_refs:
        obj["evidence"]["receiptRefs"].append(rr)
    obj.setdefault("amendments", [])
    obj["amendments"].append({
      "amendedAt": now(),
      "actorId": a.actor,
      "reason": "close intent",
      "fieldsChanged": ["status","evidence.receiptRefs"]
    })
    write_json(a.intent, obj)
    print(f"Closed: {a.intent}")

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init")
    p.add_argument("--system", required=True)
    p.add_argument("--class", dest="change_class", required=True, choices=["root","trunk","branch","leaf"])
    p.add_argument("--actor", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--risk", required=True, choices=["low","medium","high"])
    p.add_argument("--gov", action="store_true")
    p.add_argument("--scope-in", nargs="+", required=True)
    p.add_argument("--scope-out", nargs="*", default=[])
    p.add_argument("--verify-plan", default="Run project verify battery; attach receipts if required.")
    p.add_argument("--required-checks", nargs="+", default=["mk2-alteration-gate"])
    p.add_argument("--evidence-notes", default="")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("amend")
    p.add_argument("--intent", required=True)
    p.add_argument("--actor", required=True)
    p.add_argument("--reason", required=True)
    p.add_argument("--fields-changed", nargs="+", required=True)
    p.set_defaults(func=cmd_amend)

    p = sub.add_parser("close")
    p.add_argument("--intent", required=True)
    p.add_argument("--actor", required=True)
    p.add_argument("--receipt-ref", dest="receipt_refs", nargs="*", default=[])
    p.set_defaults(func=cmd_close)

    a = ap.parse_args()
    a.func(a)

if __name__ == "__main__":
    main()
