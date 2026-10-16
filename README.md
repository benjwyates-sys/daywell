# Daywell

Local-first home records for your AI agent. Daywell keeps a homeowner's appliance and system records as **exact original documents** (receipts, warranties, label photos), **sourced facts** that cite those originals, explicit uncertainty, and an append-only correction history, in a SQLite file your agent reaches through a CLI.

Your agent does the reading and reasoning. Daywell stores what it supplies, validates shape and references (not truth), and never calls a model, runs OCR, reads email or books anything.

## Get started: paste this to your agent

You don't need a terminal. Open a new conversation with your agent (Muse, Dot or any agent that can run shell commands in its own VM) and paste:

> Please set up Daywell to keep my home records. Run `npx --yes github:benjwyates-sys/daywell setup` in your shell, then read the skill file whose path it prints and follow it. Never write to Daywell's files yourself; use only the `daywell` command. Then start with `call get_agent_context` and ask me what I'd like help with first. Use my own documents and what I tell you; don't look anything up without asking me.

Your agent runs the commands, so the records live in its VM, not on your computer. Ask it to run `backup` and hand you the file now and then.

## Quick start for agents and developers

Requires Node 22.16+ and an agent that can run shell commands.

```bash
npx github:benjwyates-sys/daywell setup
```

That checks Node, creates a private store at `~/.daywell/daywell.sqlite` (override with `--db PATH` or `DAYWELL_DB`) and prints the path of the agent skill. Give the skill ([skills/daywell-local/SKILL.md](skills/daywell-local/SKILL.md)) to your agent and have it run:

```bash
npx github:benjwyates-sys/daywell call get_agent_context
```

From a clone, the same commands work as `npm install` then `npm run daywell -- setup`.

## Commands

```
daywell setup                    check Node, create the store, point at the skill (safe to repeat)
daywell tools                    list tools with read/write scope
daywell schema TOOL              JSON Schema for a tool's input
daywell call TOOL --input FILE   run a tool; JSON in from FILE or stdin, JSON out
daywell export NEW_FILE          all data, originals included, as portable JSON (never overwrites)
daywell backup NEW_FILE          consistent copy of records and preferences
daywell restore BACKUP NEW_DB    rebuild a new store from a backup
daywell info                     database location and usage
```

`--read-only` refuses write tools. Errors are JSON on stderr with exit code 1. Files are created mode 600.

## Honest limits

- **Where the data lives.** In the machine that runs the CLI. In an agent VM that is the provider's infrastructure, not your computer, and it may be reset by the provider. Run `backup` and keep a copy you control. Don't describe VM data as private to you.
- **Restore takes a `backup` file, not an `export`.** `export` is portable JSON for reading and moving data out; there is no CLI import yet.
- Originals are stored inside SQLite (20 MB each). The preferences file sits beside the database; `backup`/`restore` cover both, `export` covers records and originals only.
- No sync, hosted backup, claim packets, technician booking, email access or live connectors exist. Warranty dates, possible coverage, diagnosis and provider approval are kept distinct; Daywell never asserts a defect is covered without evidence.
- Verified on synthetic data in a Muse VM and locally; not yet tested with real users. Onboarding cards and the skill have not been exercised in every client.

## Develop

```bash
npm install
npm test
```

Tests use temporary databases only.

## Licenses

MIT for this code ([LICENSE](LICENSE)); the name "Daywell" is not licensed by it. [`prototypes/daywell-demo/assets/vehicles/catalog.js`](prototypes/daywell-demo/assets/vehicles/catalog.js) is attribution metadata for Wikimedia Commons images (CC BY-SA 4.0); the images themselves are not included.
