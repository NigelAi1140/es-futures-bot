━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ES Futures Bot — Quick Start Guide
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIRST TIME SETUP
─────────────────
1. Run the setup wizard:
     Mac/Linux:  ./setup    (or: node setup.js)
     Windows:    setup.exe  (or: node setup.js)

2. Enter your license key (from your purchase email)
3. Enter your TopstepX username and API key
   → Get your API key: TopstepX platform → Settings → API Keys → Generate
4. Choose your trading settings (press Enter for recommended defaults)

RUNNING THE BOT
───────────────
     Mac/Linux:  ./bot
     Windows:    bot.exe

The bot:
  · Verifies your license
  · Connects to TopstepX
  · Waits for the trading session to open (6:30am MST)
  · Runs automatically — no input needed
  · Stops when your daily profit cap or loss limit is hit

SETTINGS (config.json)
──────────────────────
Edit config.json any time to change settings. Key options:

  trading.contracts        Number of contracts per trade (1–5)
  trading.stopLossTicks    Stop loss distance in ticks (default: 10)
  trading.takeProfitTicks  Take profit distance in ticks (default: 40)
  trading.dailyLossLimit   Max loss per day in dollars (default: $1,400)
  trading.dailyProfitCap   Stop trading when this profit is reached (default: $2,000)

  strategies.AVWAP_L       true/false — enable/disable each strategy
  strategies.RSI2_L        true/false
  strategies.RSI2_S        true/false
  strategies.EMAPB_L       true/false
  strategies.EMAPB_S       true/false
  strategies["3BAR_BEAR_S"] true/false

  trendFilter.enabled           true/false — morning trend filter
  trendFilter.uptrendThreshold   Points up in 30min to suppress shorts (default: 10)
  trendFilter.downtrendThreshold Points down in 30min to suppress longs (default: 6)

After editing config.json, restart the bot.

BROKER API KEY
──────────────
The bot connects directly to TopstepX using your own API key.
Your account credentials never leave your machine.

To generate your TopstepX API key:
  1. Log in to the TopstepX platform
  2. Go to Settings → API Keys
  3. Click Generate New Key
  4. Copy the key into your config.json or re-run setup

SUPPORT
───────
Questions? Issues?
  Email: [your support email]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DISCLAIMER: This software is provided for educational
and informational purposes only. Trading futures
involves substantial risk of loss. Past performance
is not indicative of future results. You are solely
responsible for your trading decisions.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
