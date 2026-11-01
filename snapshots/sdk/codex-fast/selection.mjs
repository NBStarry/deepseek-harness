/** Scenario-local selections; transport remains the keyless llm-replay provider. */
export function apply(ctx) {
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (turn !== 1 && turn !== 3 && turn !== 4) return
    const { provider, model } = agent.model.current()
    agent.model.select({ provider, model, ...(turn === 3 ? {} : { serviceTier: 'priority' }) })
  })
}
