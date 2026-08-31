# Mock Resource Service — Team Playbook, Member 2, Task 1
#
# Deliberately has NO per-user authentication of its own — Member 1's
# backend layer (apps/server/src/enforcement.ts) does the real scope/token
# checking before a request ever reaches this service.
#
# UPDATE (Member 1, patching a Task 4 bypass Member 2 found): this service
# WAS reachable directly on port 8000 with zero auth at all, skipping the
# Fastify enforcement layer entirely. It now requires the same internal
# secret Fastify sends on every legitimate call, via X-Internal-Secret.
# This is not meant to be a strong secret — it's the smallest thing that
# closes the opportunistic "just curl port 8000" bypass for the demo.
# Real isolation would be a network boundary instead.
#
# Run directly:
#   python3 -m venv venv
#   source venv/bin/activate
#   pip install -r requirements.txt
#   MOCK_SERVICE_INTERNAL_SECRET=dev-only-internal-secret-change-me python3 main.py
#
# Or explicitly with uvicorn (same effect as `python3 main.py`):
#   uvicorn main:app --host 0.0.0.0 --port 8000
#
# Configurable via env vars (not hardcoded):
#   HOST (default 0.0.0.0)
#   PORT (default 8000)
#   MOCK_SERVICE_INTERNAL_SECRET (must match apps/server's same-named var)

import os

from fastapi import Depends, FastAPI, Header, HTTPException

app = FastAPI(title="Mock Resource Service")

INTERNAL_SECRET = os.environ.get(
    "MOCK_SERVICE_INTERNAL_SECRET", "dev-only-internal-secret-change-me"
)


def require_internal_secret(x_internal_secret: str | None = Header(default=None)) -> None:
    if x_internal_secret != INTERNAL_SECRET:
        # Deliberately the same 401 shape regardless of missing vs wrong
        # value — no reason to help an attacker tell those apart.
        raise HTTPException(status_code=401, detail="Missing or invalid internal secret")

# Fixture data for the demo. Deliberately fixed/hardcoded — this is what a
# *mock* service is: canned, deterministic content standing in for a real
# backend. Two users, two records, matching the frozen resource path shape
# "<owner>/notes" that apps/server/src/enforcement.ts requests.
NOTES_BY_OWNER = {
    "user_a": {
        "owner": "user_a",
        "content": "Project Falcon launch is Oct 12.",
    },
    "user_b": {
        "owner": "user_b",
        "content": "[CONFIDENTIAL] Q3 restructure: 12 roles cut.",
    },
}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/resources/{owner}/notes", dependencies=[Depends(require_internal_secret)])
def get_notes(owner: str) -> dict:
    record = NOTES_BY_OWNER.get(owner)
    if record is None:
        # Unknown owner -> 404, not a silent empty body. Keeps this service's
        # behavior honest for whatever owner Member 1's enforcement layer
        # forwards, without needing this file to know every possible owner
        # in advance.
        raise HTTPException(status_code=404, detail=f"No notes for owner '{owner}'")
    return record


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
