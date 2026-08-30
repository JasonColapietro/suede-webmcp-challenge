import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import ModeSwitch from "@/components/mode-switch";
import CopyButton from "./copy-button";
import EnvironmentBadge from "@/components/projects/EnvironmentBadge";
import ProjectContext from "@/components/projects/ProjectContext";
import { resolveOwnerId } from "@/lib/auth";
import { getCodeViewData } from "@/lib/code-view";
import { ensureOwnedFlowContext, getProjectRepo } from "@/lib/projects/provider";
import { VersionService } from "@/lib/projects/version-service";
import type { FlowVersionRecord, PersonalContext } from "@/lib/projects/types";
import { buildCodeVersionModel, buildVersionDownload } from "@/lib/projects/ui-model";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import "../../chrome.css";
import "../../site.css";
import "./code-view.css";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ flowId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { flowId } = await params;
  const ownerId = await resolveOwnerId();
  const data = await getCodeViewData(flowId, ownerId);
  const name = data?.name ?? "Agent";
  return {
    ...noIndexFollowMetadata(`/code/${encodeURIComponent(flowId)}`),
    title: `${name} | Code`,
    description: `View ${name} as TypeScript SDK source. Run it anywhere with the Suede SDK.`,
  };
}

export default async function CodeViewPage({ params }: Props): Promise<React.JSX.Element> {
  const { flowId } = await params;
  const ownerId = await resolveOwnerId();
  const data = await getCodeViewData(flowId, ownerId);
  if (data === null) notFound();

  let latest: FlowVersionRecord | null = null;
  let projectContext: PersonalContext | null = null;
  let versionCount = 0;
  let metadataError: string | null = null;
  try {
    const repo = await getProjectRepo();
    const flowContext = await ensureOwnedFlowContext({ repo, flowId, ownerId });
    if (flowContext) {
      projectContext = {
        organization: flowContext.organization,
        workspace: flowContext.workspace,
        project: flowContext.project,
        workbook: flowContext.workbook,
        environments: flowContext.environments,
      };
      const service = new VersionService(repo);
      const versions = await service.listFlowVersions({ flowId, ownerId });
      versionCount = versions.length;
      if (versions[0]) {
        latest = await service.getFlowVersion({
          flowId,
          versionId: versions[0].id,
          ownerId,
        });
      }
    }
  } catch (error: unknown) {
    metadataError = error instanceof Error ? error.message : "Version metadata unavailable.";
  }
  const codeModel = buildCodeVersionModel(data.source, latest);
  const versionDownload = latest ? buildVersionDownload(latest) : null;

  return (
    <div className="lp">
      <SiteNav />
      <main id="main-content" className="lp-shell lp-page">
        {/* Setting switch */}
        <div className="cv-switch">
          <ModeSwitch active="code" flowId={flowId} />
        </div>

        {/* Header — verbatim from copy deck section 5 */}
        <header className="lp-page-head">
          <span className="lp-eyebrow">Code</span>
          <h1>This is your agent, as code.</h1>
          <p>
            Run it anywhere with the Suede SDK. It keeps its slug, its price,
            and its spot in the directory, and it keeps earning here.
          </p>
        </header>

        <div className="cv-context">
          <ProjectContext
            context={projectContext}
            versionCount={versionCount}
            error={metadataError}
          />
        </div>

        <section className="cv-section" aria-labelledby="current-draft-title">
          <div className="cv-head">
            <div>
              <span className="lp-eyebrow">Editable source</span>
              <h2 id="current-draft-title" className="code-version-receipt__title">
                {codeModel.draftLabel}
              </h2>
            </div>
            <EnvironmentBadge kind="draft" />
          </div>

          <div className="cv-source">
            <CopyButton source={codeModel.draftSource} />
            <div className="cv-scroll" tabIndex={0} role="region" aria-label="Agent source, scrolls horizontally">
              <pre>
                <code>{codeModel.draftSource}</code>
              </pre>
            </div>
          </div>

          <div className="cv-actions">
            <Link
              href={`/code/${flowId}/agent.ts`}
              className="lp-btn lp-btn--ghost lp-btn--sm"
              download="agent.ts"
            >
              Download agent.ts
            </Link>
          </div>
        </section>

        <section className="code-version-receipt cv-section" aria-labelledby="latest-version-title">
          <div className="code-version-receipt__head">
            <div>
              <span className="lp-eyebrow">Immutable checkpoint</span>
              <h2 id="latest-version-title" className="code-version-receipt__title">
                {codeModel.latestLabel}
              </h2>
            </div>
            {latest ? <span className="version-ledger__number">v{latest.versionNumber}</span> : null}
          </div>
          {metadataError ? (
            <p className="version-panel__message" role="alert">{metadataError}</p>
          ) : latest && versionDownload ? (
            <>
              <div className="code-version-receipt__grid">
                <div className="code-version-receipt__datum">
                  <span className="code-version-receipt__key">Version</span>
                  <span className="code-version-receipt__value">v{latest.versionNumber}</span>
                </div>
                <div className="code-version-receipt__datum">
                  <span className="code-version-receipt__key">Schema</span>
                  <span className="code-version-receipt__value">{latest.schemaVersion}</span>
                </div>
                <div className="code-version-receipt__datum">
                  <span className="code-version-receipt__key">Full hash</span>
                  <span className="code-version-receipt__value">{latest.fullHash}</span>
                </div>
                <div className="code-version-receipt__datum">
                  <span className="code-version-receipt__key">Semantic hash</span>
                  <span className="code-version-receipt__value">{latest.semanticHash}</span>
                </div>
              </div>
              <div className="cv-pins">
                <span className="code-version-receipt__key">Dependency pins</span>
                {latest.dependencies.length === 0 ? (
                  <span className="code-version-receipt__value">No dependency pins.</span>
                ) : (
                  <ol className="version-ledger">
                    {latest.dependencies.map((pin) => (
                      <li key={pin.id} className="version-ledger__item">
                        <span className="version-ledger__marker" aria-hidden="true" />
                        <span className="version-ledger__number">{pin.kind}</span>
                        <span className="version-ledger__hash">{pin.resourceId}</span>
                        <span className="version-ledger__pins">{pin.version}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <a
                className="version-download"
                href={`data:application/json;charset=utf-8,${encodeURIComponent(versionDownload.content)}`}
                download={versionDownload.filename}
              >
                Download immutable JSON
              </a>
            </>
          ) : (
            <p className="version-panel__message">{codeModel.emptyMessage}</p>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
