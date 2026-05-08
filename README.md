# NovelFlow Recommender Dashboard

A beautiful, responsive dashboard for tracking Discord referral partner performance metrics.

## Features

- 🌐 **Multi-language Support**: English and Spanish
- 📊 **5 Key Metrics**: Link Visits, Unique Visitors, New Users, Subscription Revenue, Ad Revenue
- 🏆 **Live Leaderboard**: Sortable rankings by any metric, with search box
- 🔍 **Search**: Quickly find your name in the leaderboard
- 🔗 **Share**: Copy your personal stats link to share
- 💫 **Premium Animations**: Number counting animations, smooth hover effects
- 📱 **Fully Responsive**: Works on desktop and mobile
- 🎨 **Dark/Light Theme**: High-end SaaS-style design with gradient accents
- 🚀 **Coming Soon State**: Zero-data cards show "Coming Soon" instead of zeros
- ⚙️ **Admin Panel**: Press `Ctrl+Shift+A` to open the hidden admin panel
- 📋 **Data Management**: Import/Export JSON, visual editing, add/delete users
- 🎯 **Onboarding**: First-visit guide for new users

## Quick Start

1. Open `dashboard.html` in any modern web browser
2. For individual user pages, add `?user=Username` to the URL
   - Example: `dashboard.html?user=LelouchAlleah`
3. The dashboard automatically loads data from `data.json` (falls back to embedded data if offline)

## Data Update Methods

### Method 1: Edit data.json (Recommended)
1. Edit `data.json` with updated metrics
2. Push/deploy the change — the dashboard fetches it automatically

### Method 2: Admin Panel (Ctrl+Shift+A)
1. Open the dashboard in a browser
2. Press `Ctrl+Shift+A` to open the admin panel
3. Edit user metrics visually, add/delete users
4. Click "Apply Changes" to see updates live
5. Click "Export JSON" → download or copy the updated `data.json`
6. Replace the `data.json` file and redeploy

### Method 3: Import JSON
1. Press `Ctrl+Shift+A` → go to "Import JSON" tab
2. Paste your complete JSON data
3. Click "Import & Apply"

## Data Format

```json
{
  "last_updated": "2026-05-05 12:00",
  "users": {
    "Username": {
      "link_visits": 1234,
      "unique_visitors": 567,
      "new_users": 89,
      "subscription_revenue": 456.78,
      "ad_revenue": 123.45
    }
  }
}
```

## Deploy to Vercel (One-Click)

### Option A: Vercel CLI
```bash
# Install Vercel CLI
npm i -g vercel

# Navigate to the project
cd NovelFlow_Dashboard

# Deploy
vercel

# For production
vercel --prod
```

### Option B: Vercel Dashboard
1. Push this folder to a GitHub repository
2. Go to [vercel.com](https://vercel.com) → "Add New Project"
3. Import your GitHub repo
4. Framework Preset: **Other**
5. Root Directory: `NovelFlow_Dashboard` (if repo has multiple folders)
6. Click **Deploy**
7. Done! Your dashboard is live at `your-project.vercel.app`

### Important for Vercel
- This is a **pure static site** — no build step needed
- Make sure `dashboard.html` and `data.json` are in the root of the deployed directory
- Vercel automatically serves `index.html`; if you want `dashboard.html` as default, rename it to `index.html`

## Language Switching

Click the **EN/ES** buttons in the top-right corner to toggle between English and Spanish.

## Admin Panel Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` | Open Admin Panel |
| `Escape` | Close Admin Panel |

## File Structure

```
NovelFlow_Dashboard/
├── dashboard.html   # Main application (single-page app)
├── data.json       # Data source (update this file)
└── README.md        # Documentation
```

## Customization

### Adding New Users

**Via data.json:** Add a new entry to the `users` object:
```json
"NewUser": {
  "link_visits": 0,
  "unique_visitors": 0,
  "new_users": 0,
  "subscription_revenue": 0.00,
  "ad_revenue": 0.00
}
```

**Via Admin Panel:** Press `Ctrl+Shift+A` → type the username → click "+ Add"

### Updating Metrics

- **data.json**: Edit the values and redeploy
- **Admin Panel**: Edit visually, then export the updated `data.json`

## Browser Support

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## Notes

- No backend required — pure frontend application
- Data is loaded from `data.json` via fetch; falls back to embedded data for offline use
- All preferences (language, sort order, theme) are saved to localStorage
- The admin panel works in-memory only — export and save `data.json` to persist changes
- Onboarding guide shows only on first visit (stored in localStorage)
