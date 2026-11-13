import React, { useState, useEffect, useCallback } from 'react';
import type { Workspace, WorkspaceAsset } from '../types';
import { api } from '../services/api';
import { useFileDrop } from '../hooks/useFileDrop';
import { IconClose, IconDoc } from './Icons';

interface AssetsPanelProps {
  workspace: Workspace | null;
  style?: React.CSSProperties;
  onClose?: () => void;
  dragHandle?: React.ReactNode;
}

export const AssetsPanel: React.FC<AssetsPanelProps> = ({
  workspace,
  style,
  onClose,
  dragHandle,
}) => {
  const workspaceId = workspace?.id ?? null;
  const [assets, setAssets] = useState<WorkspaceAsset[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const fetchAssets = useCallback(async () => {
    if (!workspaceId) {
      setAssets([]);
      return;
    }
    try {
      const list = await api.getWorkspaceAssets(workspaceId);
      setAssets(list);
    } catch (err) {
      console.error('Failed to fetch assets', err);
      setAssets([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!workspaceId || files.length === 0) return;
    setIsUploading(true);
    try {
      await api.uploadWorkspaceAssets(workspaceId, files);
      await fetchAssets();
    } catch (err) {
      console.error('Upload failed', err);
    } finally {
      setIsUploading(false);
    }
  }, [workspaceId, fetchAssets]);

  const { dragActive, handleDrag, handleDrop } = useFileDrop(uploadFiles);

  if (!workspace) {
    return (
      <aside className="notes is-inactive" style={style}>
        <div className="notes-placeholder">
          {onClose && (
            <button className="icon-btn small panel-close-btn" onClick={onClose} type="button">
              <IconClose size={13} />
            </button>
          )}
          <h3>Assets</h3>
          <p>Select a workspace to manage assets.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="notes"
      style={style}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <div className="notes-content">
        <div className="notes-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', minWidth: 0, gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, overflow: 'hidden' }}>
            {dragHandle && <span className="drag-handle-wrapper" style={{ flexShrink: 0 }}>{dragHandle}</span>}
            <div className="notes-meta" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
              <div className="crumbs" style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ flexShrink: 0 }}>Workspace</span>
                <span className="crumb-sep" style={{ flexShrink: 0 }}>/</span>
                <b className="crumb-title" style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                  Assets & Files
                </b>
              </div>
            </div>
            {isUploading && (
              <span className="save-badge saving" style={{ marginLeft: '8px', flexShrink: 0 }}>
                Uploading...
              </span>
            )}
          </div>
          <div className="notes-actions" style={{ display: 'flex', gap: '6px', flexShrink: 0, marginLeft: 'auto' }}>
            <button
              className="icon-btn small save-btn"
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.onchange = (e) => {
                  const target = e.target as HTMLInputElement;
                  if (target.files && target.files.length > 0) {
                    uploadFiles(Array.from(target.files));
                  }
                };
                input.click();
              }}
              title="Upload File"
              type="button"
            >
              <IconDoc size={13} />
            </button>
            {onClose && (
              <button className="icon-btn small panel-close-btn" onClick={onClose} aria-label="Close Assets" type="button">
                <IconClose size={13} />
              </button>
            )}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            border: dragActive ? '2px dashed var(--accent, #007bff)' : '2px dashed transparent',
            backgroundColor: dragActive ? 'var(--surface-subtle)' : 'transparent',
            borderRadius: '6px',
            transition: 'all 0.2s ease',
            overflowY: 'auto',
          }}
        >
          {assets.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-tertiary, #888)', marginTop: '40px' }}>
              <p>No assets found.</p>
              <p>Drag & drop files here to upload to <code>figures/</code>.</p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {assets.map((asset) => (
                <li
                  key={asset.path}
                  style={{
                    padding: '8px',
                    paddingLeft: `${(asset.path.split('/').length - 1) * 16 + 8}px`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '13px',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <IconDoc size={14} />
                  {asset.path.split('/').pop()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
};
