<!-- #ZEROPS_EXTRACT_START:intro# -->
Backing store only — a managed Postgres you develop against from your laptop. Bring
the VPN up (`zcli vpn up`), point `DATABASE_URL` at the db's superuser connection,
and run `node server.js` locally. tinbase + the dashboard run on your machine; the
database is real and in the cloud.
<!-- #ZEROPS_EXTRACT_END:intro# -->
