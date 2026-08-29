# Mock Resource Service — Team Playbook, Member 2, Task 1
#
# Deliberately has NO authentication. Security is enforced entirely by
# Member 1's backend layer (apps/server/src/enforcement.ts) before a request
# ever reaches this service. This service just holds the data behind the lock.
#
# Run directly:
#   python3 -m venv venv
#   source venv/bin/activate
#   pip install -r requirements.txt
#   python3 main.py
#
# Or explicitly with uvicorn (same effect as `python3 main.py`):
#   uvicorn main:app --host 0.0.0.0 --port 8000
#
# Configurable via env vars (not hardcoded):
#   HOST (default 0.0.0.0)
#   PORT (default 8000)

import os

from fastapi import FastAPI, HTTPException

app = FastAPI(title="Mock Resource Service")

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
        "content": "Salary review: Jane K. band 7.",
    },
}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/resources/{owner}/notes")
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
