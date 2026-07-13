<!-- #ZEROPS_EXTRACT_START:intro# -->
A dev + stage pair for agent-driven development, both backed by one managed
Postgres. The dev container boots with the source + node_modules ready and idles on
`zsc noop` for an agent / developer to adopt and drive via the Zerops dev server;
the stage container runs the real app as a live reference. Single-node stores.
<!-- #ZEROPS_EXTRACT_END:intro# -->
