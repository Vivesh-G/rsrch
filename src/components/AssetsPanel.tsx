import React, { useState, useEffect, useCallback } from 'react';
import type { Workspace } from '../types';
import { api } from '../services/api';
import { IconClose, IconDoc } from './Icons';

interface Asset {
  path: string;
}

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
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const fetchAssets = useCallback(async () => {
    if (!workspace) return;
    try {
      const res = await fetch(`${api.baseUrl}/workspaces/${workspace.id}/assets`);
      if (res.ok) {
        const data = await res.json();
        setAssets(data.assets || []);
      }
    } catch (err) {
      console.error('Failed to fetch assets', err);
    }
  }, [workspace]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  const uploadFiles = async (files: File[]) => {
    if (!workspace || files.length === 0) return;
    setIsUploading(true);
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));

    try {
      const res = await fetch(`${api.baseUrl}/workspaces/${workspace.id}/assets`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        fetchAssets();
      }
    } catch (err) {
      console.error('Upload failed', err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFiles(Array.from(e.dataTransfer.files));
    }
  };

  if (!workspace) {
    return (
      <aside className="notes is-inactive" style={style}>
        <div className="notes-placeholder">
          {onClose && (
            <button className="icon-btn small panel-close-btn" onClick={onClose}>
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
      className="notes" // reuse existing panel styling for now
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
                  const ev = e as unknown as React.ChangeEvent<HTMLInputElement>;
                  if (ev.target.files && ev.target.files.length > 0) {
                    uploadFiles(Array.from(ev.target.files));
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
            backgroundColor: dragActive ? 'var(--hover, rgba(0,0,0,0.05))' : 'transparent',
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
                    borderBottom: '1px solid var(--border-light, #eee)',
                  }}
                >
                  <IconDoc size={14} />
                  {asset.path.split('/').pop()}
                </li>
              ))}
            </ul>
          )}
        </div>

        {isUploading && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>Uploading...</div>}
      </div>
    </aside>
  );
};
