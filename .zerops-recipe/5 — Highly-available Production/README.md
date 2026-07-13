<!-- #ZEROPS_EXTRACT_START:intro# -->
Production on dedicated HA hardware: 2–4 tinbase and 2–4 dashboard containers behind
the L7 balancer, over one 3-node HA managed Postgres. Only possible because tinbase
is stateless — its data lives in the managed database. REST / Auth / Storage fan out
cleanly across containers; realtime CDC across many instances is still maturing upstream.
<!-- #ZEROPS_EXTRACT_END:intro# -->
