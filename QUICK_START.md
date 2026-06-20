# ⚡ QUICK START — Glitch Deployment (5 mins)

## What you need:
✅ Neon database URL (you have this)  
✅ Anthropic API key  
✅ GitHub account  
✅ Glitch account  

---

## DO THIS NOW:

### **1. Prepare Your Neon Database**

Your connection string is ready:
```
postgresql://neondb_owner:npg_FX8yGdilcWN1@ep-spring-tree-adk3kyya.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require
```

Save it somewhere safe.

---

### **2. Get Your Anthropic API Key**

Go to: https://console.anthropic.com/api-keys

- Log in (or create account)
- Click "Create Key"
- Copy the key (starts with `sk-ant-`)
- Keep it secret!

---

### **3. Push Code to GitHub**

You need this project on GitHub so Glitch can import it.

Option A (Simple — Terminal):
```bash
# Create new repo on GitHub first (no README)
# Then:
cd /path/to/motel-refuge-glitch
git add .
git commit -m "Motel Le Refuge - Glitch migration"
git remote set-url origin https://github.com/YOUR_USERNAME/motel-refuge.git
git push -u origin main
```

Option B (Web interface):
- Go to github.com → New Repository
- Name: `motel-refuge`
- Copy the git URL
- Use it above

---

### **4. Create Glitch Project**

1. Go to **glitch.com**
2. **New Project** → **Import from GitHub**
3. Paste your repo URL (e.g., `https://github.com/yourname/motel-refuge.git`)
4. Click **Import**

Glitch will clone and set up automatically.

---

### **5. Add Environment Variables**

In Glitch:

1. Click **Tools** (bottom left) → **Terminal**
2. Or click **.env** file on left sidebar
3. Add this:

```
DATABASE_URL=postgresql://neondb_owner:npg_FX8yGdilcWN1@ep-spring-tree-adk3kyya.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require
ANTHROPIC_API_KEY=sk-ant-PASTE_YOUR_KEY_HERE
NODE_ENV=production
PORT=3000
BASE_PATH=/
```

Replace `sk-ant-PASTE_YOUR_KEY_HERE` with your actual API key.

---

### **6. Initialize Database**

In Glitch Terminal:

```bash
pnpm install
pnpm run build
pnpm --filter @workspace/db run push
```

Wait for it to finish (~2 mins).

---

### **7. Start Server**

In Terminal:

```bash
pnpm --filter @workspace/api-server run dev
```

You should see:
```
✓ Server running on http://localhost:3000
✓ Frontend ready
```

---

### **8. Test It**

Click the **Preview** button in Glitch.

You should see the Motel Le Refuge chat interface. Try asking:
- "Do you have availability next weekend?"
- "What's your pet policy?"
- "Je voudrais réserver une chambre" (French)

---

## ✅ You're Done!

Your Motel Le Refuge receptionist is LIVE on Glitch.

**Your Glitch URL:** `https://your-project-name.glitch.me`

Share this with anyone who needs to chat with your AI receptionist.

---

## Next Steps (Optional)

- [ ] Add custom domain
- [ ] Build admin dashboard to see bookings
- [ ] Integrate Reservit API
- [ ] Set up email notifications
- [ ] Improve system prompt based on real conversations

See **GLITCH_DEPLOYMENT.md** for detailed info.
