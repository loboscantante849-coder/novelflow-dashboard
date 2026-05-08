# NovelFlow Recommender Dashboard

A beautiful, responsive dashboard for tracking Discord referral partner performance metrics.

## Features

- 🌐 **Multi-language Support**: English and Spanish
- 📊 **5 Key Metrics**: Link Visits, Unique Visitors, New Users, Subscription Revenue, Ad Revenue
- 🏆 **Live Leaderboard**: Sortable rankings by any metric
- 💫 **Premium Animations**: Number counting animations, smooth hover effects
- 📱 **Fully Responsive**: Works on desktop and mobile
- 🎨 **Dark Theme**: High-end SaaS-style design with gradient accents

## Quick Start

1. Open `dashboard.html` in any modern web browser
2. For individual user pages, add `?user=Username` to the URL
   - Example: `dashboard.html?user=LelouchAlleah`

## Data Format

Edit `data.json` to update metrics. The file structure:

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

## Language Switching

Click the **EN/ES** buttons in the top-right corner to toggle between English and Spanish.

## File Structure

```
NovelFlow_Dashboard/
├── dashboard.html   # Main application (single-page app)
├── data.json       # Data source (update this file)
└── README.md        # Documentation
```

## Customization

### Adding New Users

Simply add a new entry to the `users` object in `data.json`:

```json
"NewUser": {
  "link_visits": 0,
  "unique_visitors": 0,
  "new_users": 0,
  "subscription_revenue": 0.00,
  "ad_revenue": 0.00
}
```

### Updating Metrics

Edit the numeric values in `data.json` and refresh the page. The dashboard will automatically reflect the changes.

## Browser Support

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## Notes

- No backend required - pure frontend application
- Data persists in `data.json` - make sure to keep a backup
- All preferences (language, sort order) are saved to localStorage
