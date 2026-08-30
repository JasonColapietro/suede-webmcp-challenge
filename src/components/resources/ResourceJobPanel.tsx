import type { ResourcePackBundle } from "./client";

export default function ResourceJobPanel({ pack }: { readonly pack: ResourcePackBundle | null }): React.JSX.Element {
  const job = pack?.content.jobContract;
  return (
    <section className="resource-stage" aria-labelledby="resource-job-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">04 / Job</p>
        <h2 id="resource-job-heading">Typed contract, bounded failure</h2>
        <p>{job?.jobStatement ?? "Load the server-current pack to review its Job Contract."}</p>
      </div>
      <div className="resource-schema-pair">
        <div><h3>Input schema</h3><pre>{job ? JSON.stringify(job.inputSchema, null, 2) : "Not available"}</pre></div>
        <div><h3>Output schema</h3><pre>{job ? JSON.stringify(job.outputSchema, null, 2) : "Not available"}</pre></div>
      </div>
      <div className="resource-split">
        <div><h3>Safe example</h3><pre>{job ? JSON.stringify(job.safeExample, null, 2) : "Not available"}</pre></div>
        <div><h3>Outside the job</h3><p>{job?.unsupportedRequest ?? "Not available"}</p><h3>Evidence rule</h3><p>{job?.evidenceRequirement ?? "Not available"}</p></div>
      </div>
    </section>
  );
}
