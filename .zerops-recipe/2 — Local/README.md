<!-- #ZEROPS_EXTRACT_START:intro# -->
Managed database only — run both tinbase and the dashboard on your laptop against
it over the Zerops VPN (`zcli vpn up`). Point tinbase's DATABASE_URL at db's
superuser connection, run the dashboard at TINBASE_INTERNAL_URL=http://localhost:54321.
Nothing but the durable database lives in the cloud.
<!-- #ZEROPS_EXTRACT_END:intro# -->
