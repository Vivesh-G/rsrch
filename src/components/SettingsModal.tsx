import React, { useState, useEffect } from 'react';
import type { AppSettings } from '../types';
import { api } from '../services/api';
import {
  IconClose,
  IconSettings,
  IconKey,
  IconSparkles,
  IconEye,
  IconEyeOff,
  IconSliders,
  IconCheck,
} from './Icons';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (updated: Partial<AppSettings>) => Promise<void>;
  isFirstRun?: boolean;
}

type SettingsTab = 'profile' | 'ai' | 'editor' | 'system';

const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', desc: 'Default · Ultra fast & lightweight (Free tier)' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', desc: 'High-speed multimodal reasoning (Free tier)' },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', desc: 'High-capacity open instruction model (Free tier)' },
  { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', desc: 'Architecture-optimized instruction model (Free tier)' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  isFirstRun = false,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isFirstRun && !settings.gemini_api_key_set ? 'ai' : 'profile'
  );

  // Form states
  const [userName, setUserName] = useState(settings.user_name || 'Researcher');
  const [userAffiliation, setUserAffiliation] = useState(settings.user_affiliation || '');
  const [geminiModel, setGeminiModel] = useState(() => {
    const found = GEMINI_MODELS.find((m) => m.id === settings.gemini_model);
    return found ? found.id : 'gemini-3.5-flash-lite';
  });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [aiTemperature, setAiTemperature] = useState(settings.ai_temperature ?? 0.7);
  const [aiPersona, setAiPersona] = useState(settings.ai_persona || 'academic');
  const [autoCompileDelay, setAutoCompileDelay] = useState(settings.auto_compile_delay ?? 1500);
  const [editorFontSize, setEditorFontSize] = useState(settings.editor_font_size ?? 13);
  const [editorWordWrap, setEditorWordWrap] = useState(settings.editor_word_wrap ?? true);
  const [editorLineNumbers, setEditorLineNumbers] = useState(settings.editor_line_numbers ?? true);

  // Status states
  const [isTestingKey, setIsTestingKey] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; message: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setUserName(settings.user_name || 'Researcher');
      setUserAffiliation(settings.user_affiliation || '');
      const found = GEMINI_MODELS.find((m) => m.id === settings.gemini_model);
      setGeminiModel(found ? found.id : 'gemini-3.5-flash-lite');
      setApiKeyInput('');
      setAiTemperature(settings.ai_temperature ?? 0.7);
      setAiPersona(settings.ai_persona || 'academic');
      setAutoCompileDelay(settings.auto_compile_delay ?? 1500);
      setEditorFontSize(settings.editor_font_size ?? 13);
      setEditorWordWrap(settings.editor_word_wrap ?? true);
      setEditorLineNumbers(settings.editor_line_numbers ?? true);
      setTestResult(null);
      setSaveSuccess(false);
      setSaveError(null);
      if (isFirstRun && !settings.gemini_api_key_set) {
        setActiveTab('ai');
      }
    }
  }, [isOpen, settings, isFirstRun]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleTestKey = async () => {
    setIsTestingKey(true);
    setTestResult(null);
    try {
      const res = await api.testApiKey(apiKeyInput.trim() || undefined);
      if (res.valid) {
        setTestResult({ valid: true, message: 'Valid key — ready for AI assistance!' });
      } else {
        setTestResult({ valid: false, message: res.error || 'Invalid API key or network error.' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connection failed.';
      setTestResult({ valid: false, message: msg });
    } finally {
      setIsTestingKey(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const payload: Partial<AppSettings> = {
        user_name: userName.trim() || 'Researcher',
        user_affiliation: userAffiliation.trim(),
        gemini_model: geminiModel,
        ai_temperature: Number(aiTemperature),
        ai_persona: aiPersona,
        auto_compile_delay: Number(autoCompileDelay),
        editor_font_size: Number(editorFontSize),
        editor_word_wrap: editorWordWrap,
        editor_line_numbers: editorLineNumbers,
      };

      if (apiKeyInput.trim()) {
        payload.gemini_api_key = apiKeyInput.trim();
      }

      await onSaveSettings(payload);
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        onClose();
      }, 650);
    } catch (err: unknown) {
      console.error('Failed to save settings:', err);
      const msg = err instanceof Error ? err.message : 'Failed to save settings to server.';
      setSaveError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="modal-title">Settings</div>
            {isFirstRun && (
              <span className="first-run-pill">First-Run Setup</span>
            )}
          </div>
          <button className="icon-btn small modal-close" onClick={onClose} title="Close" type="button">
            <IconClose size={12} />
          </button>
        </div>

        {isFirstRun && !settings.gemini_api_key_set && !apiKeyInput && (
          <div className="settings-welcome-banner">
            <div className="settings-welcome-title">Welcome to Rsrch</div>
            <div className="settings-welcome-sub">
              Personalize your research environment and connect your Gemini API Key for intelligent paper chats, mathematical analysis, and automated LaTeX compile.
            </div>
          </div>
        )}

        <div className="settings-shell">
          {/* Navigation Sidebar */}
          <nav className="settings-nav" aria-label="Settings Categories">
            <button
              className={`settings-nav-item ${activeTab === 'profile' ? 'active' : ''}`}
              onClick={() => setActiveTab('profile')}
              type="button"
            >
              <span className="settings-nav-icon">👤</span>
              <span className="settings-nav-label">Profile & Identity</span>
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'ai' ? 'active' : ''}`}
              onClick={() => setActiveTab('ai')}
              type="button"
            >
              <IconSparkles size={14} className="settings-nav-icon" />
              <span className="settings-nav-label">AI & Model</span>
              {!settings.gemini_api_key_set && !apiKeyInput && (
                <span className="settings-nav-badge warning">Required</span>
              )}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'editor' ? 'active' : ''}`}
              onClick={() => setActiveTab('editor')}
              type="button"
            >
              <IconSliders size={14} className="settings-nav-icon" />
              <span className="settings-nav-label">Editor & LaTeX</span>
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'system' ? 'active' : ''}`}
              onClick={() => setActiveTab('system')}
              type="button"
            >
              <IconSettings size={14} className="settings-nav-icon" />
              <span className="settings-nav-label">About & System</span>
            </button>
          </nav>

          {/* Tab Content Panel */}
          <div className="settings-content">
            {activeTab === 'profile' && (
              <div className="settings-panel animate-fade">
                <div className="settings-section-title">Researcher Profile</div>
                <p className="settings-section-desc">
                  This identity is reflected on the top bar, notes, and informs the AI assistant of who it is collaborating with.
                </p>

                <div className="settings-field">
                  <label className="modal-label" htmlFor="settingsName">
                    Display Name
                  </label>
                  <input
                    id="settingsName"
                    className="modal-input"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="Enter name"
                    maxLength={60}
                  />
                  <div className="settings-hint">Used for your avatar initial and personal greeting.</div>
                </div>

                <div className="settings-field">
                  <label className="modal-label" htmlFor="settingsAffiliation">
                    Research Field / Affiliation
                  </label>
                  <input
                    id="settingsAffiliation"
                    className="modal-input"
                    value={userAffiliation}
                    onChange={(e) => setUserAffiliation(e.target.value)}
                    placeholder="Enter affiliation"
                    maxLength={100}
                  />
                  <div className="settings-hint">Helps the AI adapt terminology and context to your field of study.</div>
                </div>

                <div className="settings-field">
                  <label className="modal-label">Avatar Preview</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
                    <div className="avatar" style={{ width: '38px', height: '38px', fontSize: '16px' }}>
                      {(userName.trim()[0] || 'R').toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{userName.trim() || 'Researcher'}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {userAffiliation.trim() || 'Independent Researcher'}
                      </div>
                    </div>
                  </div>
                </div>

                {isFirstRun && !settings.gemini_api_key_set && (
                  <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="modal-btn secondary"
                      onClick={() => setActiveTab('ai')}
                      style={{ fontSize: '12.5px' }}
                    >
                      Next: Configure AI & API Key →
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'ai' && (
              <div className="settings-panel animate-fade">
                <div className="settings-section-title">Google Gemini AI Configuration</div>
                <p className="settings-section-desc">
                  Rsrch uses Google Gemini to read papers, derive equations, and synthesize notes.
                </p>

                <div className="settings-field">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label className="modal-label" htmlFor="settingsApiKey" style={{ margin: 0 }}>
                      Gemini API Key
                    </label>
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noreferrer"
                      className="settings-link"
                    >
                      Get API key on Google AI Studio ↗
                    </a>
                  </div>

                  <div className="api-key-input-row">
                    <div className="api-key-input-wrap">
                      <IconKey size={14} className="api-key-icon" />
                      <input
                        id="settingsApiKey"
                        className="modal-input with-left-icon with-right-icon"
                        type={showApiKey ? 'text' : 'password'}
                        value={apiKeyInput}
                        onChange={(e) => {
                          setApiKeyInput(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder={
                          settings.gemini_api_key_set
                            ? 'Enter new API key'
                            : 'Enter API key'
                        }
                      />
                      <button
                        type="button"
                        className="icon-btn-text"
                        onClick={() => setShowApiKey(!showApiKey)}
                        title={showApiKey ? 'Hide key' : 'Show key'}
                      >
                        {showApiKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                      </button>
                    </div>

                    <button
                      type="button"
                      className="modal-btn secondary"
                      onClick={handleTestKey}
                      disabled={isTestingKey || (!apiKeyInput.trim() && !settings.gemini_api_key_set)}
                    >
                      {isTestingKey ? 'Verifying...' : 'Test Key'}
                    </button>
                  </div>

                  {testResult && (
                    <div className={`key-test-feedback ${testResult.valid ? 'success' : 'error'}`}>
                      {testResult.valid ? '✓ ' : '✕ '} {testResult.message}
                    </div>
                  )}

                  {!testResult && settings.gemini_api_key_set && !apiKeyInput && (
                    <div className="key-test-feedback success">
                      ✓ API key is saved and active on this device.
                    </div>
                  )}
                </div>

                <div className="settings-field">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <label className="modal-label" style={{ margin: 0 }}>Model Selection</label>
                    <span style={{ fontSize: '11px', color: 'var(--success)', fontWeight: 600 }}>Free Tier Supported</span>
                  </div>
                  <div className="model-radio-list">
                    {GEMINI_MODELS.map((m) => (
                      <label
                        key={m.id}
                        className={`model-card-option ${geminiModel === m.id ? 'selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="geminiModel"
                          value={m.id}
                          checked={geminiModel === m.id}
                          onChange={() => setGeminiModel(m.id)}
                        />
                        <div className="model-card-body">
                          <div className="model-card-name">{m.name}</div>
                          <div className="model-card-desc">{m.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="settings-field">
                  <label className="modal-label" htmlFor="settingsPersona">
                    Research Assistant Persona
                  </label>
                  <select
                    id="settingsPersona"
                    className="modal-input modal-select"
                    value={aiPersona}
                    onChange={(e) => setAiPersona(e.target.value)}
                  >
                    <option value="academic">Academic & Rigorous (Standard research citations & math)</option>
                    <option value="concise">Concise & Direct (Brief bullets, high-density answers)</option>
                    <option value="pedagogical">Explanatory & Pedagogical (Step-by-step mathematical proofs)</option>
                  </select>
                </div>

                <div className="settings-field">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className="modal-label" htmlFor="settingsTemperature" style={{ margin: 0 }}>
                      Creativity & Temperature: {aiTemperature}
                    </label>
                    <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                      {aiTemperature < 0.4 ? 'Deterministic & Precise' : aiTemperature > 0.8 ? 'Creative & Exploratory' : 'Balanced Analysis'}
                    </span>
                  </div>
                  <input
                    id="settingsTemperature"
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.1"
                    value={aiTemperature}
                    onChange={(e) => setAiTemperature(parseFloat(e.target.value))}
                    style={{ width: '100%', marginTop: '8px' }}
                  />
                </div>
              </div>
            )}

            {activeTab === 'editor' && (
              <div className="settings-panel animate-fade">
                <div className="settings-section-title">Editor & LaTeX Preferences</div>
                <p className="settings-section-desc">
                  Customize LaTeX compilation behavior, typography, and editor layout.
                </p>

                <div className="settings-field">
                  <label className="modal-label" htmlFor="settingsCompileDelay">
                    LaTeX Auto-Compile Delay
                  </label>
                  <select
                    id="settingsCompileDelay"
                    className="modal-input modal-select"
                    value={autoCompileDelay}
                    onChange={(e) => setAutoCompileDelay(parseInt(e.target.value, 10))}
                  >
                    <option value={800}>Fast (800ms after typing)</option>
                    <option value={1500}>Balanced (1.5 seconds) — Recommended</option>
                    <option value={3000}>Relaxed (3 seconds)</option>
                    <option value={0}>Manual Only (Compile on Ctrl+S / Save button)</option>
                  </select>
                  <div className="settings-hint">
                    Controls how quickly Tectonic compiles LaTeX documents in the background after edits.
                  </div>
                </div>

                <div className="settings-field">
                  <label className="modal-label" htmlFor="settingsFontSize">
                    Editor Font Size: {editorFontSize}px
                  </label>
                  <div className="font-size-picker">
                    {[12, 13, 14, 15, 16].map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`size-btn ${editorFontSize === size ? 'active' : ''}`}
                        onClick={() => setEditorFontSize(size)}
                      >
                        {size}px
                      </button>
                    ))}
                  </div>
                  <div className="settings-hint">Applies to both CodeMirror LaTeX editor and Markdown Notes editor.</div>
                </div>

                <div className="settings-field">
                  <label className="modal-label">Editor Features</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                    <label className="settings-toggle-label">
                      <input
                        type="checkbox"
                        checked={editorLineNumbers}
                        onChange={(e) => setEditorLineNumbers(e.target.checked)}
                      />
                      <span>Show line numbers in LaTeX code editor</span>
                    </label>

                    <label className="settings-toggle-label">
                      <input
                        type="checkbox"
                        checked={editorWordWrap}
                        onChange={(e) => setEditorWordWrap(e.target.checked)}
                      />
                      <span>Soft word wrapping for long paragraphs</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'system' && (
              <div className="settings-panel animate-fade">
                <div className="settings-section-title">About Rsrch</div>
                <p className="settings-section-desc">
                  Local-first AI research and document workspace.
                </p>

                <div className="system-info-card">
                  <div className="system-info-row">
                    <span className="system-info-label">Application</span>
                    <span className="system-info-val">Rsrch Studio v1.0.0</span>
                  </div>
                  <div className="system-info-row">
                    <span className="system-info-label">LaTeX Compiler</span>
                    <span className="system-info-val">Tectonic Headless Engine</span>
                  </div>
                  <div className="system-info-row">
                    <span className="system-info-label">PDF Viewer Engine</span>
                    <span className="system-info-val">EmbedPDF (PDFium WASM)</span>
                  </div>
                  <div className="system-info-row">
                    <span className="system-info-label">Local Storage State</span>
                    <span className="system-info-val">Active (Auto-synced)</span>
                  </div>
                </div>

                <div className="settings-field" style={{ marginTop: '20px' }}>
                  <label className="modal-label">Data & Reset</label>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      type="button"
                      className="modal-btn secondary"
                      onClick={() => {
                        if (confirm('Reset preferences to defaults? Workspaces and documents will not be affected.')) {
                          setUserName('Researcher');
                          setUserAffiliation('');
                          setGeminiModel('gemini-3.5-flash-lite');
                          setAiTemperature(0.7);
                          setAutoCompileDelay(1500);
                          setEditorFontSize(13);
                        }
                      }}
                    >
                      Restore Default Preferences
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Actions */}
        <div className="modal-actions" style={{ padding: '12px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ flex: 1, minWidth: 0, marginRight: '12px' }}>
            {saveError && (
              <span style={{ fontSize: '12px', color: 'var(--danger)', display: 'inline-block' }}>
                ✕ {saveError}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="modal-btn secondary" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className={`modal-btn primary ${saveSuccess ? 'is-saved' : ''}`}
              onClick={handleSave}
              disabled={isSaving}
              type="button"
            >
              {isSaving ? 'Saving...' : saveSuccess ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <IconCheck size={12} /> Saved
                </span>
              ) : (
                'Save Settings'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
