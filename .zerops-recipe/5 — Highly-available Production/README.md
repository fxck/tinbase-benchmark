<!-- #ZEROPS_EXTRACT_START:intro# -->
Production on dedicated HA hardware: 2–4 stateless app containers behind the L7
balancer, all sharing one 3-node HA managed Postgres. Only possible because the
app's state lives in the managed database — the tinbase container holds none. REST
/ Auth / Storage fan out cleanly across containers; realtime CDC across many
instances is still maturing upstream.
<!-- #ZEROPS_EXTRACT_END:intro# -->
