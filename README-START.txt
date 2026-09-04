============================================================
  HANNIBAL .#1888 — LOCAL RUN (README-START)
============================================================

  1) Install:        npm install
  2) Dev server:     npm run dev        <- http://localhost:3000
     or production:  npm run build then npm start

  Built-in login account (ready out of the box - no setup):
       user:  trojan
       pass:  1888

  - No .env file, no database - everything is merged into the code
  - To change the built-in account: src/lib/config.ts -> PANEL_USER / PANEL_PASS
  - To deploy on Vercel: read README-VERCEL.txt - upload, deploy, done
============================================================
