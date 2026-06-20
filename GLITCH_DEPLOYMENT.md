# 🚀 Motel Le Refuge - Glitch Deployment Guide

You've migrated from Replit to Glitch! Here's how to get your Motel Le Refuge receptionist online.

---

## ✅ What You Have

- ✅ **Neon PostgreSQL database** — Connection string ready
- ✅ **Project code** — Glitch-ready (Replit plugins removed)
- ✅ **API server** (Express, port 3000)
- ✅ **React frontend** (Vite)
- ✅ **Anthropic AI integration** — Ready for your API key

---

## 📋 Step-by-Step Deployment

### **Step 1: Create Glitch Project from GitHub**

1. Go to **https://glitch.com**
2. Click **"New Project"** → **"Import from GitHub"**
3. You need the code on GitHub first. For now:
   - Create a new GitHub repo
   - Push this code to it
   - OR, use Glitch's Git import if you have a public repo link

### **Step 2: Set Environment Variables in Glitch**

Once your Glitch project is created:

1. Click **".env"** (left sidebar, bottom)
2. Add these exact variables:

```
DATABASE_URL=postgresql://neondb_owner:npg_FX8yGdilcWN1@ep-spring-tree-adk3kyya.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
NODE_ENV=production
PORT=3000
BASE_PATH=/
```

**Replace `ANTHROPIC_API_KEY`** with your actual key from:
- Go to https://console.anthropic.com
- Click "API Keys"
- Copy your key and paste it above

### **Step 3: Initialize the Database Schema**

Your database is empty right now. You need to set up the tables.

In Glitch Terminal (Tools → Terminal):

```bash
pnpm install
pnpm run build
pnpm --filter @workspace/db run push
```

This creates the tables:
- `conversations` — Chat history
- `messages` — Individual messages
- `bookings` — Guest booking info

### **Step 4: Start the Server**

In Glitch Terminal:

```bash
pnpm --filter @workspace/api-server run dev
```

You should see:
```
✓ Server running on http://localhost:3000
```

---

## 🧪 Test It

1. Open your Glitch project URL (Glitch gives you a unique URL)
2. You should see the Motel Le Refuge receptionist chat
3. Try asking: "Do you have a Queen room for 2 people next Friday?"

---

## 🔄 How It Works on Glitch

**Development:**
- Edit code in Glitch editor
- Changes auto-save
- Terminal runs your dev server
- Glitch automatically restarts on file changes

**Production:**
- Glitch deploys the latest code from your Git repo
- Your `.env` file stays private (Glitch secret)
- Database stays on Neon (external)
- Server runs 24/7 on Glitch's free tier (with fair use limits)

---

## ⚠️ Important Notes

### **Free tier limits (Glitch):**
- 1,000 hours/month runtime (plenty for a hobby project)
- Auto-sleeps after 5 min of inactivity (wakes up when accessed)
- Enough for moderate traffic

### **Database backups:**
- Neon has automatic daily backups (free tier)
- Your guest data is safe

### **Custom domain:**
- Glitch gives you a `.glitch.me` domain (free)
- To use your own domain (`motellerefuge.com`), upgrade to Glitch Pro

---

## 🛠️ Troubleshooting

**"DATABASE_URL not found"**
- Check `.env` file in Glitch
- Make sure you copied the full Neon connection string

**"Cannot find module @workspace/..."**
- Run `pnpm install` first
- Then `pnpm run build`

**Port 3000 already in use**
- Glitch sets PORT automatically; just use it
- Don't hardcode port numbers

**React app not loading**
- Check that `vite` build succeeded
- Look at browser console for errors
- API server needs to be running

---

## 📱 Next Steps

### **Enhance the Agent:**
- Add more context to the system prompt
- Improve language handling (you can expand beyond French/English)
- Add email notifications when bookings come in

### **Track Bookings Better:**
- Build a simple admin dashboard (Glitch can host this)
- Export guest emails monthly
- Analyze conversation patterns

### **Connect to Reservit:**
- Once Reservit API is ready, integrate it here
- Agent can then modify/cancel bookings
- Real-time availability checking

---

## 🎯 You're Good to Go!

Your Motel Le Refuge AI receptionist is now on Glitch with:
- ✅ 24/7 uptime
- ✅ PostgreSQL database (Neon)
- ✅ Bilingual support (French/English)
- ✅ Guest conversation tracking
- ✅ Zero monthly costs (free tier)

**Questions?** Check Glitch docs: https://glitch.help

Good luck! 🍀
