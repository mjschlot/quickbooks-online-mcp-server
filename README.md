# QuickBooks Online MCP Server

<div align="center">

**A comprehensive Model Context Protocol (MCP) server for QuickBooks Online**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tools](https://img.shields.io/badge/Tools-145-green.svg)](#available-tools)
[![Entities](https://img.shields.io/badge/Entities-29-orange.svg)](#entities)
[![Reports](https://img.shields.io/badge/Reports-11-purple.svg)](#reports)
[![Coverage](https://img.shields.io/badge/Coverage-100%25-brightgreen.svg)](#testing)
[![Tests](https://img.shields.io/badge/Tests-396-blue.svg)](#testing)

[Quick Start](#quick-start) | [Available Tools](#available-tools) | [Authentication](#authentication) | [Documentation](#documentation)

</div>

---

## Overview

This MCP server provides complete QuickBooks Online API integration for Claude Code and other MCP-compatible clients. It includes full CRUD operations for 29 entity types and 11 financial reports, giving you comprehensive access to QuickBooks Online functionality.

### Key Features

- **145 Total Tools** - Complete coverage of QuickBooks Online API
- **29 Entity Types** - Full CRUD operations (Create, Read, Update, Delete, Search)
- **11 Financial Reports** - Balance Sheet, P&L, Cash Flow, and more
- **OAuth 2.0 Authentication** - Secure token-based authentication
- **TypeScript** - Full type safety with Zod validation
- **Tested** - Jest test suite with ESM support

> Note: this is a local MCP server. It runs as a stdio subprocess on the developer's or partner's machine and authenticates to a QuickBooks Online company.

> **Before you start:** This MCP server is easy to run once authenticated, but QuickBooks Online integration is gated by Intuit's OAuth app setup. You must register an app on the [Intuit Developer Portal](https://developer.intuit.com) and complete a one-time, browser-based OAuth handshake. **Sandbox** supports `http://localhost` redirect URIs; **production** requires a public HTTPS callback for the initial authorization. After that initial handshake, the server runs locally without further browser interaction (until the 100-day refresh window lapses). See [Authentication](#authentication) for full details.

---

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/mcp-quickbooks-online.git
cd mcp-quickbooks-online

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

Copy the template `.env.example` to `.env` in the root directory and fill in your values:

```bash
cp .env.example .env
```

```env
QUICKBOOKS_CLIENT_ID=your_client_id
QUICKBOOKS_CLIENT_SECRET=your_client_secret
QUICKBOOKS_ENVIRONMENT=sandbox
QUICKBOOKS_REFRESH_TOKEN=your_refresh_token
QUICKBOOKS_REALM_ID=your_realm_id

# Optional: control which tool categories are registered, and whether they
# require human approval (default: allow, i.e. all tools registered, no approval)
# QUICKBOOKS_WRITE_MODE=approval    # allow | approval | disabled — governs create_* tools
# QUICKBOOKS_UPDATE_MODE=approval   # allow | approval | disabled — governs update_* tools
# QUICKBOOKS_DELETE_MODE=approval   # allow | approval | disabled — governs delete_* tools
```

See [Mutation Modes and Approval](#mutation-modes-and-approval) below for the full reference, including the legacy `QUICKBOOKS_DISABLE_*` flags, which are still supported.

`.env` is gitignored so your real credentials stay local.

> **Read-only or containerized installs:** the server reads `.env` at startup and writes the rotated refresh token back to it on each refresh. When the installed module sits on a **read-only filesystem** (a container with a read-only root, an immutable/Nix install), set `QUICKBOOKS_TOKEN_STORE_PATH` to an absolute, writable path for both operations. A per-tenant host can also point each connection at its own isolated token file this way. Three things to know: it must be set in the **host process env** (e.g. the `env` block of your MCP server config) — setting it inside `.env` has no effect, because the path is resolved before `.env` is read; it must be an **absolute** path (the server refuses to start otherwise); and when set, the package's own `.env` is not read at all, so any file-based config (including credentials) must live in the file it points to.

### Claude Code Integration

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["path/to/mcp-quickbooks-online/dist/index.js"],
      "env": {
        "QUICKBOOKS_CLIENT_ID": "your_client_id",
        "QUICKBOOKS_CLIENT_SECRET": "your_client_secret",
        "QUICKBOOKS_REFRESH_TOKEN": "your_refresh_token",
        "QUICKBOOKS_REALM_ID": "your_realm_id",
        "QUICKBOOKS_ENVIRONMENT": "sandbox",
        "QUICKBOOKS_WRITE_MODE": "allow",
        "QUICKBOOKS_UPDATE_MODE": "approval",
        "QUICKBOOKS_DELETE_MODE": "approval"
      }
    }
  }
}
```

Each `*_MODE` variable accepts `allow` (register the tool, no approval needed — default), `approval` (register the tool, but require human approval on every call), or `disabled` (do not register the tool). The legacy `QUICKBOOKS_DISABLE_WRITE` / `QUICKBOOKS_DISABLE_UPDATE` / `QUICKBOOKS_DISABLE_DELETE` flags still work and are used when the corresponding `*_MODE` variable is unset. Read tools (`get_*`, `search_*`, `read_*`) are always available and are never gated. See [Mutation Modes and Approval](#mutation-modes-and-approval).

---

## Mutation Modes and Approval

Three environment variables independently control whether `create_*`, `update_*`, and `delete_*` tools are registered, and whether their calls require human approval before reaching QuickBooks:

| Variable | Governs |
|----------|---------|
| `QUICKBOOKS_WRITE_MODE` | `create_*` tools (named `WRITE` to match the legacy `QUICKBOOKS_DISABLE_WRITE`) |
| `QUICKBOOKS_UPDATE_MODE` | `update_*` tools |
| `QUICKBOOKS_DELETE_MODE` | `delete_*` tools |

Each accepts one of three values (case-insensitive, surrounding whitespace trimmed; unset counts as empty):

| Value | Tool registered? | Approval required? |
|-------|:---:|:---:|
| `allow` (default) | Yes | No |
| `approval` | Yes | Yes, on every call |
| `disabled` | No | N/A |

Read tools (`get_*`, `search_*`, `read_*`) are never gated by these variables.

Set these in `.env` or in the MCP host's `env` block. Unlike `QUICKBOOKS_TOKEN_STORE_PATH`, they are read after `.env` loads, so either location works. Set each variable in one location only. If the host environment sets a mode or `QUICKBOOKS_APPROVAL_*` variable and the token store file sets it to a different value, the server refuses to start.

### Precedence

1. A `*_MODE` variable set to a valid value wins.
2. Otherwise, the legacy flag is checked: the exact string `"true"` in `QUICKBOOKS_DISABLE_WRITE` / `QUICKBOOKS_DISABLE_UPDATE` / `QUICKBOOKS_DISABLE_DELETE` maps to `disabled`.
3. Otherwise, the mode defaults to `allow`.

An invalid `*_MODE` value (anything other than `allow`, `approval`, or `disabled`) makes the server refuse to start, with an error naming the offending variable.

### Example configurations

Require approval for every mutation:

```env
QUICKBOOKS_WRITE_MODE=approval
QUICKBOOKS_UPDATE_MODE=approval
QUICKBOOKS_DELETE_MODE=approval
```

Allow creation, approve updates and deletes:

```env
QUICKBOOKS_WRITE_MODE=allow
QUICKBOOKS_UPDATE_MODE=approval
QUICKBOOKS_DELETE_MODE=approval
```

Read-only (no mutation tools registered):

```env
QUICKBOOKS_WRITE_MODE=disabled
QUICKBOOKS_UPDATE_MODE=disabled
QUICKBOOKS_DELETE_MODE=disabled
```

### How approval works

For a tool in `approval` mode, after the MCP SDK validates the call's arguments against the tool's schema, the server:

1. Checks that the connected client advertised the MCP `elicitation` (form) capability. If not, the call fails closed with an error, and no request is sent to QuickBooks.
2. Gets the realm ID from the QuickBooks client — the company the mutation will actually target. This may authenticate first (a token refresh, or in sandbox the interactive OAuth flow) before the prompt appears.
3. For `create_attachable`, pins the file content (see below).
4. Canonicalizes the exact arguments and computes a SHA-256 hash over the tool name, mutation category, realm ID, arguments, and any pinned file facts, then issues a single-use approval ID that expires after `QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS`.
5. Sends an `elicitation/create` form request showing the operation type (CREATE/UPDATE/DELETE, with a conspicuous warning for DELETE), the tool name, realm ID, pinned file content, identifiers, amount-like fields, every field of the exact payload, the approval ID, the payload hash, and the expiry. The user must set `approve` to true and accept the form.
6. On approval, re-checks the client's realm ID (blocking the call if the company changed), consumes the single-use approval, and runs the handler with exactly the approved arguments.

Decline, cancel, accepting without `approve=true`, timeout, a cancelled tool call, client/elicitation errors, an expired, replayed, or mismatched approval, a QuickBooks company change after approval, a file that cannot be pinned, and internal errors all block the call — none of them send a request to QuickBooks. Each approval covers exactly one call; retrying or changing arguments requires a new approval. Approval state is kept in memory only: it does not survive a server restart, and approvals are never persisted or reused across restarts.

`QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS` (integer, 1–3600, default `300`) sets how long the user has to respond before the approval expires. An invalid value makes the server refuse to start.

### Audit log

```env
QUICKBOOKS_APPROVAL_AUDIT_LOG=true
QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH=/absolute/path/to/audit.jsonl
```

When enabled, the server writes one JSON object per line for each approval-mode call. `QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH` must be an absolute path; the file is created with mode `0600`. Enabling the log without a path, with a relative path, or setting a path without also setting `QUICKBOOKS_APPROVAL_AUDIT_LOG=true` makes the server refuse to start.

Each record has:

| Field | Notes |
|-------|-------|
| `timestamp` | |
| `approvalId` | |
| `toolName` | |
| `category` | |
| `payloadHash` | |
| `realmId` | |
| `outcome` | one of `requested`, `approved`, `declined`, `canceled`, `expired`, `unsupported-client`, `approval-error`, `replayed`, `hash-mismatch`, `executed`, `execution-failed` |
| `entityId` | optional, best effort |
| `error` | optional, sanitized — token-like values redacted, message truncated |

Argument and payload values are never logged, only their hash. Credentials and OAuth tokens are never logged. `allow`-mode mutations are not audited by this log.

If the log is enabled and a write fails before the QuickBooks request is sent (`requested`/`approved` outcomes), the mutation is blocked. If the write fails after the QuickBooks request has already run, the server reports the failure on stderr and still returns the result — the mutation has already happened and cannot be undone by a failed log write.

### Client compatibility

Support for MCP form elicitation varies by client and version; verify against the client you actually use. As researched in September 2026:

- **Supports it:** Claude Code (interactive sessions), Cursor, OpenAI Codex CLI (custom MCP servers, since April 2026), MCP Inspector.
- **Does not support it:** Claude Desktop, Zed.
- **Unverified:** VS Code / GitHub Copilot, Windsurf.

Caveats:

- Claude Code headless/print mode (`-p`) auto-cancels elicitations unless a hook answers them — approval-mode mutations are blocked in that mode, and a hook that auto-approves defeats the safeguard.
- Cursor has reported issues routing an elicitation to the correct window when multiple windows are open.
- Some clients apply their own tool-call timeout, which may be shorter than `QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS`.
- The server cannot verify that a human, rather than an automated hook or client policy, answered the prompt — the client is responsible for showing it to a person.

For `create_attachable`, the server reads the `file_path` content or downloads the `file_url` before asking for approval, shows the content's size and SHA-256 in the prompt, and uploads exactly those pinned bytes. A `file_url` download therefore happens before approval, so a declined, denied, or cancelled call may already have downloaded the content (cancelling the tool call aborts a download in progress); no QuickBooks request is sent before approval. The pinned copy is deleted when the call finishes.

Approval covers the arguments sent to the tool, not other data read when the mutation runs: update handlers may merge the approved patch with the current QuickBooks record fetched at execution time (for example, its `SyncToken`), so the approval does not cover the full stored record.

Approval mode is a server-enforced safeguard. It is not a substitute for QuickBooks user permissions, OAuth credential security, backups, review processes, or accounting controls. The LLM is not the security boundary; approval is enforced in server code.

---

## Available Tools

### Entities

Complete CRUD operations are available for all entity types:

| Entity | Create | Get | Update | Delete | Search |
|--------|:------:|:---:|:------:|:------:|:------:|
| **Customer** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Invoice** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Estimate** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Bill** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Vendor** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Employee** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Account** | ✅ | ✅ | ✅ | - | ✅ |
| **Item** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Journal Entry** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Bill Payment** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Purchase** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Payment** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Sales Receipt** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Credit Memo** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Refund Receipt** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Purchase Order** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Vendor Credit** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Deposit** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Transfer** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Time Activity** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Class** | ✅ | ✅ | ✅ | - | ✅ |
| **Department** | ✅ | ✅ | ✅ | - | ✅ |
| **Term** | ✅ | ✅ | ✅ | - | ✅ |
| **Payment Method** | ✅ | ✅ | ✅ | - | ✅ |
| **Tax Code** | - | ✅ | - | - | ✅ |
| **Tax Rate** | - | ✅ | - | - | ✅ |
| **Tax Agency** | - | ✅ | - | - | ✅ |
| **Company Info** | - | ✅ | ✅ | - | - |
| **Attachable** | ✅ | ✅ | ✅ | ✅ | ✅ |

### Reports

| Report | Tool Name | Description |
|--------|-----------|-------------|
| **Balance Sheet** | `get_balance_sheet` | Assets, liabilities, and equity snapshot |
| **Profit & Loss** | `get_profit_and_loss` | Income and expenses over a period |
| **Cash Flow** | `get_cash_flow` | Cash inflows and outflows |
| **Trial Balance** | `get_trial_balance` | Debit and credit balances |
| **General Ledger** | `get_general_ledger` | Complete transaction history |
| **Customer Sales** | `get_customer_sales` | Sales by customer |
| **Aged Receivables** | `get_aged_receivables` | Outstanding customer invoices |
| **Aged Receivables Detail** | `get_aged_receivables_detail` | Detailed aging breakdown |
| **Customer Balance** | `get_customer_balance` | Current customer balances |
| **Aged Payables** | `get_aged_payables` | Outstanding vendor bills |
| **Vendor Expenses** | `get_vendor_expenses` | Expenses by vendor |

---

## Tool Reference

<details>
<summary><strong>Customer Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_customer` | Create a new customer |
| `get_customer` | Get customer by ID |
| `update_customer` | Update customer details |
| `delete_customer` | Delete a customer |
| `search_customers` | Search customers with filters |

</details>

<details>
<summary><strong>Invoice Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_invoice` | Create a new invoice |
| `get_invoice` | Get invoice by ID |
| `update_invoice` | Update invoice details |
| `delete_invoice` | Delete/void an invoice |
| `search_invoices` | Search invoices with filters |
| `get_invoice_pdf` | Download an invoice as a PDF (inline base64, or to disk when `QBO_PDF_OUTPUT_DIR` is set) |

</details>

<details>
<summary><strong>Payment Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_payment` | Record a customer payment |
| `get_payment` | Get payment by ID |
| `update_payment` | Update payment details |
| `delete_payment` | Void a payment |
| `search_payments` | Search payments with filters |

</details>

<details>
<summary><strong>Bill & Vendor Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_bill` | Create a new bill |
| `get_bill` | Get bill by ID |
| `update_bill` | Update bill details |
| `delete_bill` | Delete a bill |
| `search_bills` | Search bills with filters |
| `create_vendor` | Create a new vendor |
| `get_vendor` | Get vendor by ID |
| `update_vendor` | Update vendor details |
| `delete_vendor` | Delete a vendor |
| `search_vendors` | Search vendors with filters |
| `create_bill_payment` | Create a bill payment |
| `get_bill_payment` | Get bill payment by ID |
| `update_bill_payment` | Update bill payment |
| `delete_bill_payment` | Delete a bill payment |
| `search_bill_payments` | Search bill payments |

</details>

<details>
<summary><strong>Sales Receipt & Credit Memo Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_sales_receipt` | Create a sales receipt |
| `get_sales_receipt` | Get sales receipt by ID |
| `update_sales_receipt` | Update sales receipt |
| `delete_sales_receipt` | Void a sales receipt |
| `search_sales_receipts` | Search sales receipts |
| `create_credit_memo` | Create a credit memo |
| `get_credit_memo` | Get credit memo by ID |
| `update_credit_memo` | Update credit memo |
| `delete_credit_memo` | Void a credit memo |
| `search_credit_memos` | Search credit memos |
| `create_refund_receipt` | Create a refund receipt |
| `get_refund_receipt` | Get refund receipt by ID |
| `update_refund_receipt` | Update refund receipt |
| `delete_refund_receipt` | Void a refund receipt |
| `search_refund_receipts` | Search refund receipts |

</details>

<details>
<summary><strong>Banking Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_deposit` | Create a bank deposit |
| `get_deposit` | Get deposit by ID |
| `update_deposit` | Update deposit details |
| `delete_deposit` | Delete a deposit |
| `search_deposits` | Search deposits |
| `create_transfer` | Create an account transfer |
| `get_transfer` | Get transfer by ID |
| `update_transfer` | Update transfer details |
| `delete_transfer` | Delete a transfer |
| `search_transfers` | Search transfers |

</details>

<details>
<summary><strong>Purchase Order & Vendor Credit Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_purchase_order` | Create a purchase order |
| `get_purchase_order` | Get purchase order by ID |
| `update_purchase_order` | Update purchase order |
| `delete_purchase_order` | Delete a purchase order |
| `search_purchase_orders` | Search purchase orders |
| `create_vendor_credit` | Create a vendor credit |
| `get_vendor_credit` | Get vendor credit by ID |
| `update_vendor_credit` | Update vendor credit |
| `delete_vendor_credit` | Delete a vendor credit |
| `search_vendor_credits` | Search vendor credits |

</details>

<details>
<summary><strong>Time Tracking Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_time_activity` | Create a time activity |
| `get_time_activity` | Get time activity by ID |
| `update_time_activity` | Update time activity |
| `delete_time_activity` | Delete a time activity |
| `search_time_activities` | Search time activities |

</details>

<details>
<summary><strong>Classification Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_class` | Create a class |
| `get_class` | Get class by ID |
| `update_class` | Update class details |
| `search_classes` | Search classes |
| `create_department` | Create a department |
| `get_department` | Get department by ID |
| `update_department` | Update department |
| `search_departments` | Search departments |

</details>

<details>
<summary><strong>Settings Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `create_term` | Create a payment term |
| `get_term` | Get term by ID |
| `update_term` | Update term details |
| `search_terms` | Search terms |
| `create_payment_method` | Create a payment method |
| `get_payment_method` | Get payment method by ID |
| `update_payment_method` | Update payment method |
| `search_payment_methods` | Search payment methods |
| `get_preferences` | Get company accounting and feature preferences |

</details>

<details>
<summary><strong>Tax Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `get_tax_code` | Get tax code by ID |
| `search_tax_codes` | Search tax codes |
| `get_tax_rate` | Get tax rate by ID |
| `search_tax_rates` | Search tax rates |
| `get_tax_agency` | Get tax agency by ID |
| `search_tax_agencies` | Search tax agencies |

</details>

<details>
<summary><strong>Company & Attachments</strong></summary>

| Tool | Description |
|------|-------------|
| `get_company_info` | Get company information |
| `update_company_info` | Update company info |
| `create_attachable` | Create an attachment |
| `get_attachable` | Get attachment by ID |
| `update_attachable` | Update attachment |
| `delete_attachable` | Delete an attachment |
| `search_attachables` | Search attachments |

</details>

---

## Authentication

This server uses OAuth 2.0 to authenticate to a QuickBooks Online company. You'll set up an app on the [Intuit Developer Portal](https://developer.intuit.com/) and connect it to either a **sandbox** (for development) or your **production** QBO company.

### Important: Sandbox vs Production

| Mode | When to use | Redirect URI accepted | Setup difficulty |
|------|-------------|------------------------|------------------|
| **Sandbox** | Development, testing, demos | `http://localhost:8000/callback` works | Easy |
| **Production** | Real company data | Localhost **rejected** — must be a public HTTPS URL | Harder (see below) |

If you only want to read your own company's data, you still need to set up an app — Intuit does not offer per-user API keys. There is no shortcut around the OAuth + app-creation flow.

### Sandbox Setup (recommended for first run)

1. Go to the [Intuit Developer Portal](https://developer.intuit.com/) and create a new app
2. Open the app → **Settings** (left sidebar) → **Redirect URIs** → add: `http://localhost:8000/callback`
3. Get your **Client ID** and **Client Secret** from the app's **Keys & Credentials** page (Development keys)
4. Create or use a sandbox company under the **Sandbox** top-level menu item in the dev portal
5. Set `QUICKBOOKS_ENVIRONMENT=sandbox` in your `.env`
6. Run `npm run auth` to complete the OAuth handshake — your browser will open, you sign in to the sandbox company, tokens are saved to `.env`

### Production Setup

The Intuit Developer Portal **rejects `http://localhost` redirect URIs in production mode** — every contributor hits this. Two known workarounds:

1. **ngrok tunnel (most common):** run `ngrok http 8000`, then on your Intuit app go to **Settings → Redirect URIs** and add the generated `https://<id>.ngrok-free.app/callback` URL. Use that URL for the OAuth handshake, then revert to localhost afterwards.
2. **Deploy a small public callback handler** (e.g., on a VPS or serverless function) that captures the auth code and hands it back to your local setup. More involved; only needed if you can't use ngrok.

After completing the production OAuth handshake, the refresh token is what matters — once it's in `.env`, you no longer need the public redirect URL for day-to-day use. Refresh tokens auto-rotate; the server persists the new token on each refresh.

### Once you have tokens

```env
QUICKBOOKS_CLIENT_ID=your_client_id
QUICKBOOKS_CLIENT_SECRET=your_client_secret
QUICKBOOKS_REFRESH_TOKEN=your_refresh_token
QUICKBOOKS_REALM_ID=your_realm_id
QUICKBOOKS_ENVIRONMENT=sandbox  # or 'production'
```

### Common pitfalls

- **`.env` loaded from the wrong directory.** The server resolves `.env` relative to the compiled module, not your shell's CWD. If you launch via Claude Desktop, this matters — make sure you're on current `main`.
- **Redirect URI mismatch.** The URI you register in the Intuit portal must match **exactly** — protocol, host, port, path. `http://localhost:8000/callback` .

---

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

The test suite includes **396 tests** with **100% code coverage** across all metrics (statements, branches, functions, lines).

### Project Structure

```
src/
├── clients/          # QuickBooks API client
├── handlers/         # Business logic handlers (87 files)
├── tools/           # MCP tool definitions
├── helpers/         # Utility functions
├── types/           # TypeScript types
└── index.ts         # Server entry point

tests/
├── unit/            # Unit tests (396 tests)
│   ├── handlers/    # Handler tests (15 test files)
│   └── helpers/     # Helper tests
└── mocks/           # Test mocks

docs/
├── ARCHITECTURE.md  # System architecture & design patterns
├── TESTING.md       # Testing guide & patterns
└── plans/           # Development plans
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [CHANGELOG.md](CHANGELOG.md) | Version history and all changes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, patterns, and design decisions |
| [docs/TESTING.md](docs/TESTING.md) | Testing strategy, ESM patterns, and coverage guide |

---

## Error Handling

If you encounter connection errors:

1. Verify all environment variables are set correctly
2. Check that tokens are valid and not expired
3. Ensure the QuickBooks app has the correct redirect URIs
4. For sandbox testing, use `QUICKBOOKS_ENVIRONMENT=sandbox`

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Tool naming convention

All tool names must follow the `{verb}_{entity}` convention (hyphen variants such as `create-` are also accepted). The verb prefix determines the mutation category and which mode variable governs it:

| Prefix | Category | Governed by |
|--------|----------|-------------|
| `create_`, `create-` | WRITE | `QUICKBOOKS_WRITE_MODE` (legacy `QUICKBOOKS_DISABLE_WRITE=true`) |
| `update_`, `update-` | UPDATE | `QUICKBOOKS_UPDATE_MODE` (legacy `QUICKBOOKS_DISABLE_UPDATE=true`) |
| `delete_`, `delete-` | DELETE | `QUICKBOOKS_DELETE_MODE` (legacy `QUICKBOOKS_DISABLE_DELETE=true`) |
| `get_`, `search_`, `read_`, `get-`, `search-`, `read-` | READ | never gated |

A tool name that matches none of these prefixes makes the server refuse to start — unrecognized names are no longer silently treated as read tools. New tools must use one of the prefixes above.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- Based on [Intuit's QuickBooks Online MCP Server](https://github.com/intuit/quickbooks-online-mcp-server)
- Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
