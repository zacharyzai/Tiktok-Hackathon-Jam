# Mock Resource Service

Standalone FastAPI app holding fake per-user data with **no authentication of
its own** — Member 1's backend (`apps/server/src/enforcement.ts`) is the only
thing that decides who's allowed to reach it. That's deliberate: this service
proves the lock is doing the work, not a login screen here.

## Run it

```bash
cd mock-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

Defaults to `http://localhost:8000`, which matches the server's
`MOCK_SERVICE_URL` default (see `apps/server/src/config.ts`). Override with
env vars if you need a different port:

```bash
PORT=8001 python3 main.py
```

## Endpoints

- `GET /health` -> `{"status": "ok"}`
- `GET /resources/user_a/notes` -> User A's fixture note
- `GET /resources/user_b/notes` -> User B's fixture note (deliberately
  sensitive-sounding — this is the payload that should never leak to
  Agent-Alpha in the demo)

Any other owner returns `404`.
