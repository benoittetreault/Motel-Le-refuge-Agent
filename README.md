# 🏨 Motel Le Refuge AI Receptionist

An intelligent, bilingual (French/English) AI receptionist chatbot for **Motel Le Refuge** in Lennoxville, Quebec.

**Built with:** TypeScript, React, Express, PostgreSQL (Neon), Claude (Anthropic AI)

**Hosted on:** Glitch (free tier)

---

## What It Does

The receptionist handles guest inquiries about:
- ✅ Room availability and rates
- ✅ Room amenities and features
- ✅ Check-in/check-out policies
- ✅ Pet policies and deposits
- ✅ Special requests (late arrivals, parking, accessibility)
- ✅ Direct booking links via Reservit
- ✅ Bilingual support (responds in the guest's language)

**Conversation data is stored** — you can review past chats, build an email list, and analyze patterns.

---

## Rooms & Rates

| Room Type | Weekday | Weekend | Max Guests | Special |
|-----------|---------|---------|-----------|---------|
| Queen | $100 | $110 | 2 | Standard |
| Double | $110 | $120 | 4 | Standard |
| Deluxe | $120 | $130 | 2 | Glass shower |
| Suite | $225 | $225 | 4 | Kitchenette |

---

## Quick Start (5 mins)

👉 **See [QUICK_START.md](./QUICK_START.md)** for step-by-step deployment

Or detailed info in [GLITCH_DEPLOYMENT.md](./GLITCH_DEPLOYMENT.md)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│         React Frontend (Vite)                   │
│  Chat interface + booking form                  │
└─────────────────┬───────────────────────────────┘
                  │ HTTP API
┌─────────────────┴───────────────────────────────┐
│         Express API Server (Node.js)            │
│  • Chat routing                                 │
│  • Message processing                          │
│  • Anthropic Claude integration                │
│  • Booking validation                          │
└─────────────────┬───────────────────────────────┘
                  │ SQL
┌─────────────────┴───────────────────────────────┐
│    PostgreSQL Database (Neon)                   │
│  • Conversations (chat sessions)                │
│  • Messages (individual chat turns)             │
│  • Bookings (guest info + dates)                │
└─────────────────────────────────────────────────┘
```

---

## Tech Stack

### Frontend
- **React 18** — UI framework
- **Vite** — Build tool (fast dev, optimized prod)
- **TypeScript** — Type safety
- **Tailwind CSS** — Styling
- **Radix UI** — Accessible components
- **React Hook Form** — Form handling
- **Zod** — Schema validation

### Backend
- **Node.js 24** — Runtime
- **Express 5** — HTTP server
- **TypeScript** — Type safety
- **Drizzle ORM** — Database layer
- **Zod** — API validation

### AI & Database
- **Anthropic Claude** — AI receptionist brain
- **PostgreSQL (Neon)** — Persistent storage
- **pnpm workspaces** — Monorepo management

### Deployment
- **Glitch** — Hosting (free tier)
- **Neon** — Database (free tier)

---

## Monorepo Structure

```
artifacts/
├── api-server/           Express server on port 3000
├── motel-refuge/         React frontend (Vite)
└── mockup-sandbox/       Demo environment

lib/
├── api-spec/             OpenAPI specification
├── api-client-react/     Generated API hooks (TypeScript)
├── api-zod/              Zod schemas for validation
├── db/                   Drizzle ORM + database schema
└── integrations-anthropic-ai/  Claude integration
```

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Type check everything
pnpm run typecheck

# Build all packages
pnpm run build

# Run API server (port 3000)
pnpm --filter @workspace/api-server run dev

# Generate API code from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Push database schema changes
pnpm --filter @workspace/db run push
```

---

## Environment Variables

Create a `.env` file:

```env
# Neon PostgreSQL
DATABASE_URL=postgresql://user:password@host/neondb?sslmode=require

# Anthropic API (get from https://console.anthropic.com/api-keys)
ANTHROPIC_API_KEY=sk-ant-...

# Deployment
NODE_ENV=production
PORT=3000
BASE_PATH=/
```

---

## Database Schema

### `conversations`
```sql
id (PK)
title (string)
createdAt (timestamp)
```

### `messages`
```sql
id (PK)
conversationId (FK → conversations)
role (string: "user" or "assistant")
content (text)
createdAt (timestamp)
```

### `bookings`
```sql
id (PK)
conversationId (FK → conversations)
fullName (string)
phone (string)
email (string)
checkIn (date)
checkOut (date)
guests (int)
roomType (enum)
hasPet (boolean)
language (enum: "fr", "en")
status (enum: "pending", "confirmed")
createdAt (timestamp)
```

---

## How It Works

1. **Guest visits** the motel website and clicks chat
2. **Chat interface loads** (React frontend)
3. **Guest types message** (French or English)
4. **Message sent to API** (Express server)
5. **AI processes it** (Claude + Anthropic API)
6. **Response generated** (contextual, helpful, warm)
7. **Data stored** (conversation + messages in PostgreSQL)
8. **If booking info provided** → saved to `bookings` table
9. **Guest is directed** to Reservit for final booking

---

## Deployment

### On Glitch (Recommended)

1. Push code to GitHub
2. Import repo into Glitch
3. Set environment variables
4. Initialize database: `pnpm --filter @workspace/db run push`
5. Start server: `pnpm --filter @workspace/api-server run dev`
6. Done! ✅

See [QUICK_START.md](./QUICK_START.md) for details.

### On Your Own Server

Same commands work anywhere Node.js + PostgreSQL are available. Just ensure:
- Node 24+
- pnpm installed
- PostgreSQL 13+ (or Neon)
- Anthropic API key
- PORT available (default 3000)

---

## Customization

### Change System Prompt
Edit: `lib/integrations-anthropic-ai/src/system-prompt.ts`

### Modify Room Types/Rates
Edit: `lib/db/src/schema/bookings.ts` and backend API

### Styling
Edit: `artifacts/motel-refuge/src/` (Tailwind classes)

### Database Schema
Edit: `lib/db/src/schema/*.ts` then run `pnpm --filter @workspace/db run push`

---

## Limitations & Future Work

### Current
- ❌ Cannot process/modify/cancel bookings (Reservit API pending)
- ❌ No email notifications yet
- ❌ No admin dashboard

### Planned
- ✅ Reservit API integration (handle real bookings)
- ✅ Email notifications (new bookings, confirmations)
- ✅ Admin dashboard (view all conversations + bookings)
- ✅ SMS/WhatsApp integration
- ✅ Extended language support

---

## Troubleshooting

**"Database connection failed"**
- Check `.env` DATABASE_URL is correct
- Verify Neon console shows your connection string
- Test connection: `psql <CONNECTION_STRING>`

**"ANTHROPIC_API_KEY not set"**
- Check `.env` file exists
- Verify key starts with `sk-ant-`
- Restart server after adding key

**"Cannot find module @workspace/..."**
- Run `pnpm install`
- Run `pnpm run build`

**"React app not loading"**
- Check browser console for errors
- Verify API server is running on port 3000
- Check API is returning data: visit `http://localhost:3000/api/health`

---

## Support & Resources

- **Glitch Help:** https://glitch.help
- **Neon Docs:** https://neon.tech/docs
- **Anthropic API:** https://docs.anthropic.com
- **React:** https://react.dev
- **Express:** https://expressjs.com

---

## License

MIT

---

## Credits

Built for **Motel Le Refuge**, Lennoxville, QC

Powered by **Claude (Anthropic)** | Hosted on **Glitch** | Database on **Neon**

---

**Ready to deploy?** → [QUICK_START.md](./QUICK_START.md)
