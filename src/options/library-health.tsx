import { localizeText, tr } from "../shared/i18n";
import type { LibraryMetadata, TemplateBackup } from "../shared/template-client";

type LibraryHealthProps = {
  metadata: LibraryMetadata | null;
  error: string | null;
  saving: boolean;
  onRecover: (backup: TemplateBackup) => void;
  onExportBackup: (backup: TemplateBackup) => void;
};

const MEBIBYTE = 1024 * 1024;

export function LibraryHealth({ metadata, error, saving, onRecover, onExportBackup }: LibraryHealthProps) {
  const used = metadata?.bytesInUse;
  const quota = metadata?.quotaBytes;
  const hasUsage = typeof used === "number" && Number.isFinite(used) && used >= 0;
  const hasQuota = typeof quota === "number" && Number.isFinite(quota) && quota > 0;
  const almostFull = hasUsage && hasQuota && used >= quota * 0.9;

  return (
    <section className="library-health" aria-label={tr("Library storage and recovery")}>
      <style>{LIBRARY_HEALTH_STYLES}</style>
      <h3>{tr("Storage")}</h3>
      <p className="library-storage-usage">
        {hasUsage && hasQuota
          ? tr("$1 MiB of $2 MiB used ($3%).", (used / MEBIBYTE).toFixed(2), (quota / MEBIBYTE).toFixed(2), Math.round(used / quota * 100))
          : hasUsage ? tr("$1 MiB used.", (used / MEBIBYTE).toFixed(2))
          : tr("Storage usage unavailable.")}
      </p>
      {almostFull ? (
        <p className="library-health-warning" role="status">
          {tr("Storage is almost full. Export a backup and remove templates you no longer need.")}
        </p>
      ) : null}
      {error ? <p className="library-health-error" role="status">{localizeText(error)}</p> : null}
      {metadata && metadata.backups.length > 0 ? (
        <div className="library-recovery">
          <h3>{tr("Saved recovery backups")}</h3>
          <p>{tr("Older template data was backed up after a storage problem. Export it or preview recoverable templates before restoring.")}</p>
          <ul>
            {metadata.backups.map((backup) => (
              <li key={backup.id}>
                <time dateTime={backup.backedUpAt}>{backup.backedUpAt}</time>
                <p className="library-backup-reason">{localizeText(backup.reason)}</p>
                <div className="library-recovery-actions">
                  <button type="button" disabled={saving} onClick={() => onExportBackup(backup)}>{tr("Export backup")}</button>
                  <button type="button" disabled={saving} onClick={() => onRecover(backup)}>{tr("Try recovery")}</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const LIBRARY_HEALTH_STYLES = `
  .library-health { display: grid; gap: 8px; min-width: 0; padding-top: 12px; border-top: 1px solid var(--pc-divider); }
  .library-health h3 { margin: 0; font-size: 13px; }
  .library-health p, .library-health time { font-size: 12px; overflow-wrap: anywhere; }
  .library-storage-usage, .library-backup-reason { color: var(--pc-muted); }
  .library-health-warning { padding: 8px; border: 1px solid var(--pc-accent); border-radius: 6px; }
  .library-health-error { color: var(--pc-danger); }
  .library-recovery { display: grid; gap: 8px; }
  .library-recovery ul { display: grid; gap: 10px; max-height: 260px; overflow: auto; list-style: none; padding: 0; margin: 0; }
  .library-recovery li { display: grid; gap: 6px; padding: 8px; border-radius: 6px; background: var(--pc-item); }
  .library-recovery-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .library-health button { min-height: 34px; padding: 7px 10px; }
`;
