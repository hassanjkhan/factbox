#!/usr/bin/env python3
"""Generate credits.html from the site data.

Grouped by licence tier, because that is the distinction that matters: the
public-domain plates are a courtesy list, the other thirteen are an obligation.
"""
import json, pathlib, sys, html

SITE = pathlib.Path(sys.argv[1])
stacks = json.load(open(SITE/"data"/"stacks.json"))["stacks"]

plates = []
for s in stacks:
    for cr, cap, role in ([(s["cr"], s["cap"], "")] +
                          [(x["cr"], x["cap"], " · 2nd") for x in s["supp"]]):
        if cr: plates.append((s["id"] + role, cap, cr))

def row(sid, cap, cr):
    lic = (f'<a href="{html.escape(cr["licenseUrl"])}" rel="noopener" target="_blank">'
           f'{html.escape(cr["license"])}</a>' if cr.get("licenseUrl")
           else html.escape(cr["license"] or ""))
    src = (f'<a href="{html.escape(cr["source"])}" rel="noopener" target="_blank">source</a>'
           if cr.get("source") else "")
    who = (f'<span class="by">{html.escape(cr["credit"])}</span>'
           if cr.get("credit") and cr["tier"] != "public_domain" else "")
    return (f'<tr><td class="n">{html.escape(sid)}</td>'
            f'<td>{html.escape(cap or cr.get("artwork") or "")}{who}</td>'
            f'<td class="l">{lic}<br>{src}</td></tr>')

def table(tier):
    rs = [row(*p) for p in plates if p[2]["tier"] == tier]
    return (f'<div class="wrap"><table><thead><tr><th>Story</th><th>Artwork</th>'
            f'<th>Licence</th></tr></thead><tbody>{"".join(rs)}</tbody></table></div>'), len(rs)

t_sa, n_sa = table("share_alike")
t_at, n_at = table("attribution")
t_pd, n_pd = table("public_domain")

page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Artwork credits</title>
<meta name="description" content="Every plate used in Factbox, with its source and licence.">
<meta name="theme-color" content="#0E0B12">
<link rel="stylesheet" href="css/app.css">
<style>
  .doc{{max-width:780px;margin:0 auto;padding:var(--top-safe) 18px 72px}}
  .doc h1{{font-size:clamp(1.7rem,6vw,2.2rem);font-weight:850;margin:20px 0 12px;letter-spacing:-.015em}}
  .doc h2{{font-size:1rem;font-weight:800;margin:36px 0 4px}}
  .doc p{{color:var(--dim);line-height:1.6;margin:0 0 10px;max-width:62ch;font-size:.94rem}}
  table{{width:100%;border-collapse:collapse;margin-top:12px;font-size:.82rem}}
  th,td{{text-align:left;vertical-align:top;padding:9px 8px;border-bottom:1px solid var(--hair)}}
  th{{color:var(--dimmer);font-size:.68rem;letter-spacing:.11em;text-transform:uppercase}}
  td.n{{color:var(--dimmer);font-variant-numeric:tabular-nums;white-space:nowrap;width:1%}}
  td.l{{white-space:nowrap;width:1%;color:var(--dimmer)}}
  .by{{display:block;color:var(--dimmer);margin-top:3px}}
  .wrap{{overflow-x:auto}}
</style>
</head>
<body>
<main class="doc">
  <p class="mark">FACTBOX</p>
  <h1>Artwork credits</h1>
  <p>Every plate in Factbox, with its source and licence. {n_pd} are public domain
     or public-domain equivalent. {n_sa + n_at} are used under Creative Commons terms
     and are credited both here and on the card where they appear.</p>
  <p>Plates are reproduced at reduced resolution for delivery. Nothing we serve has
     been cropped, recoloured or otherwise adapted; framing happens in the browser at
     display time.</p>

  <h2>Share-alike ({n_sa})</h2>
  <p>Reproduced unmodified under the named licence, with attribution.</p>
  {t_sa}

  <h2>Attribution ({n_at})</h2>
  {t_at}

  <h2>Public domain ({n_pd})</h2>
  <p>No attribution required. Listed as a courtesy to the institutions that
     digitised them.</p>
  {t_pd}

  <p style="margin-top:30px"><a class="ghost" href="/explore">← All stories</a></p>
</main>
</body>
</html>'''
(SITE/"credits.html").write_text(page)
print(f"credits.html : share-alike {n_sa}, attribution {n_at}, public domain {n_pd}, total {n_sa+n_at+n_pd}")
