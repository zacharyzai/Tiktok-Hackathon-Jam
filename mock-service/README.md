# Mock Resource Service

Standalone FastAPI app holding fake per-user data with **no per-user
authentication of its own** — Member 1's backend (`apps/server/src/enforcement.ts`)
is the only thing that decides which Agent may reach which owner's data.
That's deliberate: this service proves the lock is doing the work, not a
login screen here.

It does require one shared internal secret from Fastify (`X-Internal-Secret`)
so a direct `curl` to port 8000 can't skip the Fastify layer entirely — see
"Bypass patched" below.

## Run it

```bash
cd mock-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
MOCK_SERVICE_INTERNAL_SECRET=dev-only-internal-secret-change-me python3 main.py
```

Must match the same-named var the Fastify server uses (`apps/server/.env`,
same default value, so it works out of the box in local dev without setting
anything — override both together if you change it).

Defaults to `http://localhost:8000`, which matches the server's
`MOCK_SERVICE_URL` default (see `apps/server/src/config.ts`). Override with
env vars if you need a different port:

```bash
PORT=8001 python3 main.py
```

## Bypass patched (Task 4 finding)

A direct `curl http://localhost:8000/resources/user_b/notes` used to return
full data with zero auth, skipping the Fastify enforcement layer entirely.
`/resources/{owner}/notes` now requires `X-Internal-Secret` to match
`MOCK_SERVICE_INTERNAL_SECRET`; a request without it (or with the wrong
value) gets `401`. `/health` is intentionally left open for liveness checks.
This is not meant to be a strong secret — the actual fix for a real
deployment would be a network boundary; this is the smallest thing that
closes the opportunistic bypass for the demo.

## Endpoints

- `GET /health` -> `{"status": "ok"}`
- `GET /resources/user_a/notes` -> User A's fixture note
- `GET /resources/user_b/notes` -> User B's fixture note (deliberately
  sensitive-sounding — this is the payload that should never leak to
  Agent-Alpha in the demo)

Any other owner returns `404`.
