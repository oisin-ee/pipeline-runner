interface PipelineCompactionOutput {
  context: string[];
}

export const PipelineGoalContext = async () => ({
  "experimental.session.compacting": (
    _input: unknown,
    output: PipelineCompactionOutput
  ) => {
    output.context.push(
      [
        "## Pipeline Goal Context",
        "Preserve the current task, schedule node, failed gates, verifier evidence, acceptance evidence, changed files, and exact next requirement.",
        "Do not mark the goal complete without deterministic verifier and acceptance evidence.",
      ].join("\n")
    );
  },
});
