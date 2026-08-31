# Docker secrets (Compose / ECS deployment only)

`npm run poc` (the local judging path) doesn't use anything in this folder —
it reads `ARK_API_KEY` directly from `.env`, same as always.

This folder only matters if you use `docker compose up` / the ECS deploy
script. Those read the Ark key from a **file**, not a plain environment
variable, so `docker compose config` never prints the real key.

## One-time setup

```bash
printf '%s' 'your-ark-api-key' > secrets/ark_api_key.txt
```

`ark_api_key.txt` is gitignored — never commit it. `ark_api_key.txt.example`
is the only file in this folder that's tracked in git, and it's a placeholder.
