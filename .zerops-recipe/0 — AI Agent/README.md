<!-- #ZEROPS_EXTRACT_START:intro# -->
The tinbase backend + managed Postgres, plus a dev/stage pair of the benchmark
dashboard for agent-driven development. tinbase runs as a stable service (it's the
product, not what you edit); the agent adopts the dev dashboard container (idles on
`zsc noop`) and drives it via the Zerops dev server, with the stage dashboard as a
running reference.
<!-- #ZEROPS_EXTRACT_END:intro# -->
