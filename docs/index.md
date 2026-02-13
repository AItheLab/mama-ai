# Mama Documentation

Production and development documentation for Mama AI Agent.

## Start Here

- For real 24/7 deployment and operations, read:
  - `docs/OPERATIONS-AND-DEPLOYMENT.md`

## Quick Production Checklist

1. Use Node 22 LTS.
2. Build from source:
   - `pnpm install`
   - `pnpm build`
3. Initialize:
   - `node dist/index.js init --yes --force --name "YourName"`
4. Configure:
   - `~/.mama/config.yaml`
5. Start daemon:
   - `node dist/index.js daemon start`
6. Verify:
   - `node dist/index.js daemon status`
   - `node dist/index.js daemon logs -n 200`

## Generate a Docs Site

This repository includes `mkdocs.yml`.

Example local workflow:

```bash
python3 -m pip install mkdocs mkdocs-material
mkdocs serve
```

Then open:

- `http://127.0.0.1:8000`

