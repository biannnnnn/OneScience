import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  Compass,
  Copy,
  Database,
  ExternalLink,
  FileCheck2,
  FileText,
  FolderOpen,
  Info,
  LayoutDashboard,
  LibraryBig,
  ListChecks,
  Loader2,
  MessageSquareReply,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  UploadCloud,
} from 'lucide-react';
import { api } from './api.js';

const steps = [
  { label: '稿件评估', short: '评估', icon: ScanSearch },
  { label: '期刊匹配', short: '选刊', icon: Compass },
  { label: '模拟审稿', short: '审稿', icon: ClipboardCheck },
  { label: '投稿准备', short: '材料', icon: FileCheck2 },
  { label: 'Rebuttal', short: '回复', icon: MessageSquareReply },
  { label: '流程归档', short: '归档', icon: Database },
];

const scoreLabels = {
  completeness: '结构完整性',
  novelty: '创新表达',
  reproducibility: '可复现性',
  evidence: '证据充分性',
  clarity: '写作清晰度',
};

const severityLabels = { high: '高风险', medium: '需关注', low: '建议优化' };

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

function Button({ children, variant = 'primary', loading = false, icon: Icon, ...props }) {
  return (
    <button className={`button button-${variant}`} disabled={loading || props.disabled} {...props}>
      {loading ? <Loader2 size={17} className="spin" /> : Icon ? <Icon size={17} /> : null}
      <span>{children}</span>
    </button>
  );
}

function App() {
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [workspaceView, setWorkspaceView] = useState('projects');
  const [activeStep, setActiveStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelStatus, setModelStatus] = useState(null);

  const refreshProjects = async () => {
    const result = await api.listProjects();
    setProjects(result);
    return result;
  };

  useEffect(() => {
    refreshProjects().catch((requestError) => setError(requestError.message));
    api.modelStatus().then(setModelStatus).catch(() => setModelStatus(null));
  }, []);

  const runAction = async (name, action, nextStep) => {
    setBusy(name);
    setError('');
    try {
      const result = await action();
      setCurrentProject(result);
      await refreshProjects();
      if (Number.isInteger(nextStep)) setActiveStep(nextStep);
      return result;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const openProject = async (id) => {
    await runAction('open', () => api.getProject(id));
    setWorkspaceView('projects');
    setActiveStep(0);
  };

  const startNew = () => {
    setWorkspaceView('projects');
    setCurrentProject(null);
    setActiveStep(0);
    setError('');
  };

  const patchCurrent = (patch, name = 'save') =>
    runAction(name, () => api.patchProject(currentProject.id, patch));

  const runLibraryMatching = async () => {
    if (!currentProject) return null;
    const result = await runAction('library-match', () => api.recommend(currentProject.id));
    if (result) {
      setWorkspaceView('projects');
      setActiveStep(1);
    }
    return result;
  };

  const selectJournalFromLibrary = async (journal) => {
    if (!currentProject) return null;
    const result = await runAction(
      `library-journal-${journal.id}`,
      () => api.patchProject(currentProject.id, {
        selectedJournal: journal,
        status: `已选择 ${journal.name}`,
        stage: Math.max(currentProject.stage, 2),
      }),
    );
    if (result) {
      setWorkspaceView('projects');
      setActiveStep(1);
    }
    return result;
  };

  const context = {
    project: currentProject,
    busy,
    runAction,
    patchCurrent,
    setActiveStep,
  };

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        projects={projects}
        currentId={currentProject?.id}
        activeView={workspaceView}
        onOpen={openProject}
        onNew={startNew}
        onOpenProjects={() => {
          setWorkspaceView('projects');
          setError('');
        }}
        onOpenLibrary={() => {
          setWorkspaceView('journals');
          setError('');
        }}
      />

      <main className="main-shell">
        <Topbar
          project={currentProject}
          section={workspaceView === 'journals' ? '期刊知识库' : ''}
          modelStatus={modelStatus}
          onToggle={() => setSidebarOpen((value) => !value)}
        />
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="关闭错误提示">×</button>
          </div>
        )}

        {workspaceView === 'journals' ? (
          <JournalLibraryPage
            currentProject={currentProject}
            busy={busy}
            onRunMatching={runLibraryMatching}
            onOpenMatching={() => {
              setWorkspaceView('projects');
              setActiveStep(1);
            }}
            onSelectJournal={selectJournalFromLibrary}
            onCreateProject={startNew}
          />
        ) : !currentProject ? (
          <UploadWorkspace
            busy={busy}
            onCreated={(project) => {
              setCurrentProject(project);
              setActiveStep(0);
              refreshProjects();
            }}
            runAction={runAction}
          />
        ) : (
          <div className="workspace">
            <ProjectHeader project={currentProject} />
            <WorkflowSteps
              activeStep={activeStep}
              onChange={setActiveStep}
              project={currentProject}
            />
            <section className="stage-panel">
              {activeStep === 0 && <AnalysisStage {...context} />}
              {activeStep === 1 && <JournalStage {...context} />}
              {activeStep === 2 && <ReviewStage {...context} />}
              {activeStep === 3 && <MaterialsStage {...context} />}
              {activeStep === 4 && <RebuttalStage {...context} />}
              {activeStep === 5 && <ArchiveStage {...context} />}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Sidebar({ open, onToggle, projects, currentId, activeView, onOpen, onNew, onOpenProjects, onOpenLibrary }) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><BookOpen size={22} /></div>
        {open && (
          <div className="brand-copy">
            <strong>OneScience</strong>
            <span>Submission Copilot</span>
          </div>
        )}
        <button className="icon-button sidebar-toggle" onClick={onToggle} aria-label="切换侧栏">
          <LayoutDashboard size={18} />
        </button>
      </div>

      <div className="sidebar-body">
        <Button variant="sidebar" icon={Plus} onClick={onNew}>新建投稿项目</Button>

        {open && (
          <>
            <div className="sidebar-section-label">工作台</div>
            <button className={`side-nav ${activeView === 'projects' ? 'active' : ''}`} onClick={onOpenProjects}><FolderOpen size={17} />投稿项目</button>
            <button className={`side-nav ${activeView === 'journals' ? 'active' : ''}`} onClick={onOpenLibrary}><LibraryBig size={17} />期刊知识库<span className="coming">71 本</span></button>

            <div className="sidebar-section-label project-label">最近项目</div>
            <div className="project-list">
              {projects.length === 0 && <p className="sidebar-empty">还没有项目，上传论文开始分析。</p>}
              {projects.slice(0, 8).map((project) => (
                <button
                  key={project.id}
                  className={`project-link ${currentId === project.id ? 'selected' : ''}`}
                  onClick={() => onOpen(project.id)}
                >
                  <span className="project-file-icon"><FileText size={15} /></span>
                  <span className="project-link-copy">
                    <strong>{project.name}</strong>
                    <small>{project.status} · {formatDate(project.updatedAt)}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {open && (
        <div className="sidebar-footer">
          <ShieldCheck size={17} />
          <div><strong>本地 MVP</strong><span>原始论文不持久化保存</span></div>
        </div>
      )}
    </aside>
  );
}

function Topbar({ project, section, modelStatus, onToggle }) {
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={onToggle}><LayoutDashboard size={18} /></button>
      <div className="breadcrumb">
        <span>投稿智能体</span>
        {section ? <><ChevronRight size={14} /><strong>{section}</strong></> : project && <><ChevronRight size={14} /><strong>{project.name}</strong></>}
      </div>
      <div className="topbar-meta">
        <span className="system-status">
          <span className={`status-dot ${modelStatus?.configured ? 'model-ready' : ''}`} />
          {modelStatus?.configured ? `${modelStatus.model} 已配置` : '规则分析服务正常'}
        </span>
        <div className="avatar">OS</div>
      </div>
    </header>
  );
}

function JournalRankBadges({ journal }) {
  const badges = [
    journal.ccfTier && { label: journal.ccfTier, className: journal.ccfTier.toLowerCase() },
    journal.ccfRank && { label: journal.ccfRank, className: journal.ccfRank.toLowerCase() },
    journal.casZone && { label: journal.casZone, className: `cas-${journal.casZone.match(/\d/)?.[0] || ''}` },
  ].filter(Boolean);

  return badges.map((badge) => (
    <span className={`journal-rank-badge ${badge.className}`} key={badge.label}>{badge.label}</span>
  ));
}

function JournalLibraryPage({
  currentProject,
  busy,
  onRunMatching,
  onOpenMatching,
  onSelectJournal,
  onCreateProject,
}) {
  const [library, setLibrary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [field, setField] = useState('全部领域');
  const [publisher, setPublisher] = useState('全部出版社');
  const [access, setAccess] = useState('全部模式');
  const [rank, setRank] = useState('全部期刊等级');
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.journals()
      .then((result) => {
        if (!active) return;
        setLibrary(result);
        setSelectedId((value) => value || result.items?.[0]?.id || '');
      })
      .catch((requestError) => active && setLoadError(requestError.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const journals = library?.items || [];
  const fields = [...new Set(journals.flatMap((journal) => journal.fields))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const publishers = [...new Set(journals.map((journal) => journal.publisher))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const accessModes = [...new Set(journals.map((journal) => journal.access))];
  const rankOrder = ['CCF-T1', 'CCF-T2', 'CCF-A', 'CCF-B', 'CCF-C', '中科院1区', '中科院2区', '中科院3区', '中科院4区'];
  const ranks = [...new Set(journals.flatMap((journal) => [journal.ccfTier, journal.ccfRank, journal.casZone]).filter(Boolean))]
    .sort((a, b) => rankOrder.indexOf(a) - rankOrder.indexOf(b));
  const normalizedQuery = query.trim().toLowerCase();
  const filteredJournals = journals.filter((journal) => {
    const searchable = [
      journal.name,
      journal.englishName,
      journal.publisher,
      journal.organizer,
      journal.ccfTier,
      journal.ccfRank,
      journal.casZone,
      journal.cn,
      journal.language,
      journal.profile,
      ...journal.fields,
      ...journal.audience,
      ...journal.evidencePreferences,
    ].join(' ').toLowerCase();
    return (!normalizedQuery || searchable.includes(normalizedQuery))
      && (field === '全部领域' || journal.fields.includes(field))
      && (publisher === '全部出版社' || journal.publisher === publisher)
      && (access === '全部模式' || journal.access === access)
      && (rank === '全部期刊等级' || [journal.ccfTier, journal.ccfRank, journal.casZone].includes(rank));
  });
  const selectedJournal = filteredJournals.find((journal) => journal.id === selectedId)
    || filteredJournals[0]
    || null;
  const existingMatch = selectedJournal
    ? currentProject?.recommendations?.items?.find((journal) => journal.id === selectedJournal.id)
    : null;
  const isTarget = selectedJournal?.id === currentProject?.selectedJournal?.id;
  const clearFilters = () => {
    setQuery('');
    setField('全部领域');
    setPublisher('全部出版社');
    setAccess('全部模式');
    setRank('全部期刊等级');
  };

  return (
    <div className="journal-library-page">
      <header className="library-hero">
        <div>
          <span className="section-kicker">JOURNAL KNOWLEDGE BASE</span>
          <h1>期刊知识库</h1>
          <p>浏览计算机与人工智能期刊目录，包含 CCF 2025 T1/T2 中文刊，以及带有 CCF-A/B/C 和中科院分区的国际刊；核对研究范围和证据偏好，再与当前论文进行适配分析。</p>
        </div>
        <div className="library-version">
          <LibraryBig size={21} />
          <span><strong>{library?.catalog?.size || 71} 本期刊</strong><small>{library?.catalog?.version || '正在读取目录'}</small></span>
        </div>
      </header>

      <section className="library-toolbar surface-card">
        <label className="library-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索期刊、研究领域、目标读者…" />
        </label>
        <select value={rank} onChange={(event) => setRank(event.target.value)} aria-label="期刊等级筛选">
          <option>全部期刊等级</option>
          {ranks.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select value={field} onChange={(event) => setField(event.target.value)} aria-label="研究领域筛选">
          <option>全部领域</option>
          {fields.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select value={publisher} onChange={(event) => setPublisher(event.target.value)} aria-label="出版机构筛选">
          <option>全部出版社</option>
          {publishers.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select value={access} onChange={(event) => setAccess(event.target.value)} aria-label="开放获取筛选">
          <option>全部模式</option>
          {accessModes.map((item) => <option key={item}>{item}</option>)}
        </select>
      </section>

      {loadError ? (
        <div className="library-state error"><AlertCircle size={22} /><h2>期刊目录加载失败</h2><p>{loadError}</p></div>
      ) : loading ? (
        <div className="library-state"><Loader2 size={25} className="spin" /><h2>正在读取期刊知识库</h2></div>
      ) : (
        <div className="library-layout">
          <section className="library-results surface-card">
            <div className="library-results-heading">
              <span>检索结果</span>
              <strong>{filteredJournals.length}</strong>
            </div>
            {filteredJournals.length ? (
              <div className="library-journal-list">
                {filteredJournals.map((journal) => (
                  <button
                    key={journal.id}
                    className={selectedJournal?.id === journal.id ? 'selected' : ''}
                    onClick={() => setSelectedId(journal.id)}
                    aria-pressed={selectedJournal?.id === journal.id}
                  >
                    <span className="library-journal-mark">{journal.name.slice(0, 2).toUpperCase()}</span>
                    <span className="library-journal-copy">
                      <strong>{journal.name}</strong>
                      <small><JournalRankBadges journal={journal} />{journal.publisher} · {journal.access}</small>
                      <span>{journal.fields.slice(0, 3).join(' · ')}</span>
                    </span>
                    {currentProject?.selectedJournal?.id === journal.id && <CheckCircle2 size={18} />}
                  </button>
                ))}
              </div>
            ) : (
              <div className="library-empty"><Search size={24} /><strong>没有找到符合条件的期刊</strong><button onClick={clearFilters}>清除筛选条件</button></div>
            )}
          </section>

          <aside className="library-detail surface-card">
            {selectedJournal ? (
              <>
                <div className="library-detail-header">
                  <div>
                    <span className="section-kicker">JOURNAL PROFILE</span>
                    <h2>{selectedJournal.name}</h2>
                    {selectedJournal.englishName && <span className="library-english-name">{selectedJournal.englishName}</span>}
                    <p>{selectedJournal.publisher} · {selectedJournal.access}</p>
                  </div>
                  <a href={selectedJournal.source.url} target="_blank" rel="noreferrer"><ExternalLink size={15} />官方来源</a>
                </div>
                <p className="library-profile">{selectedJournal.profile}</p>
                {(selectedJournal.ccfTier || selectedJournal.ccfRank || selectedJournal.casZone || selectedJournal.cn || selectedJournal.language) && (
                  <div className="library-catalog-meta">
                    <JournalRankBadges journal={selectedJournal} />
                    {selectedJournal.cn && <span>CN {selectedJournal.cn}</span>}
                    {selectedJournal.language && <span>{selectedJournal.language}</span>}
                    {selectedJournal.organizer && <span>主办：{selectedJournal.organizer}</span>}
                  </div>
                )}
                <div className="library-field-tags">{selectedJournal.fields.map((item) => <span key={item}>{item}</span>)}</div>
                <div className="library-detail-grid">
                  <section><strong>目标读者</strong>{selectedJournal.audience.map((item) => <p key={item}><Target size={14} />{item}</p>)}</section>
                  <section><strong>证据偏好</strong>{selectedJournal.evidencePreferences.map((item) => <p key={item}><CheckCircle2 size={14} />{item}</p>)}</section>
                </div>
                <div className="library-source-note"><Info size={16} /><span>{selectedJournal.source.label}，数据核对日期 {selectedJournal.source.checkedAt}。CCF 国际等级采用 2022 版目录，中科院分区采用 2025 年 3 月升级版；未显示标签表示当前目录中未核实收录。平台标签用于辅助匹配，投稿前请再次查看期刊官网与最新评价目录。</span></div>

                <div className="library-project-link">
                  {currentProject ? (
                    <>
                      <div className="library-project-heading">
                        <span><FileText size={17} />当前论文</span>
                        <strong>{currentProject.name}</strong>
                      </div>
                      {existingMatch ? (
                        <div className="library-existing-match">
                          <span>已有 AI 适配结果<strong>{existingMatch.matchScore}</strong></span>
                          <p>{existingMatch.reasons?.[0]}</p>
                        </div>
                      ) : (
                        <p className="library-no-match">当前结果尚未包含该期刊，可重新运行 AI 匹配，或由作者核对后直接设为目标期刊。</p>
                      )}
                      <div className="library-actions">
                        <Button variant="secondary" loading={busy === 'library-match'} onClick={existingMatch ? onOpenMatching : onRunMatching} icon={existingMatch ? ScanSearch : Sparkles}>
                          {existingMatch ? '查看完整适配' : '运行 AI 匹配'}
                        </Button>
                        <Button
                          variant={isTarget ? 'selected' : 'primary'}
                          loading={busy === `library-journal-${selectedJournal.id}`}
                          disabled={isTarget}
                          onClick={() => onSelectJournal(existingMatch || selectedJournal)}
                          icon={isTarget ? Check : Target}
                        >
                          {isTarget ? '已是目标期刊' : '设为目标期刊'}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="library-project-heading"><span><FileText size={17} />论文适配</span><strong>尚未创建投稿项目</strong></div>
                      <p className="library-no-match">上传论文后，系统会结合稿件主题、目标读者和证据准备度生成可解释适配结果。</p>
                      <Button onClick={onCreateProject} icon={Plus}>创建投稿项目</Button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="library-empty"><LibraryBig size={26} /><strong>请选择一本期刊</strong></div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function UploadWorkspace({ busy, onCreated, runAction }) {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [researchField, setResearchField] = useState('');
  const [keywords, setKeywords] = useState('');
  const [accessPreference, setAccessPreference] = useState('不限');
  const [useAI, setUseAI] = useState(true);
  const inputRef = useRef(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!file) return;
    const formData = new FormData();
    formData.append('paper', file);
    formData.append('researchField', researchField);
    formData.append('keywords', keywords);
    formData.append('accessPreference', accessPreference);
    formData.append('useAI', String(useAI));
    const result = await runAction('upload', () => api.analyze(formData));
    if (result) onCreated(result);
  };

  const createDemo = async () => {
    const result = await runAction('demo', api.createDemo);
    if (result) onCreated(result);
  };

  const selectFile = (candidate) => {
    if (candidate) setFile(candidate);
  };

  return (
    <div className="welcome-page">
      <div className="welcome-hero">
        <div className="eyebrow"><Sparkles size={15} />从一篇稿件开始</div>
        <h1>让每一步投稿决策<br /><em>有依据、可追踪</em></h1>
        <p>上传论文，通过可解释规则与 DeepSeek 深度评估完成期刊匹配、模拟审稿、投稿材料与 Rebuttal 的完整准备流程。</p>
        <div className="hero-points">
          <span><CheckCircle2 size={16} />结构化质量检查</span>
          <span><CheckCircle2 size={16} />可解释匹配依据</span>
          <span><CheckCircle2 size={16} />全过程项目留痕</span>
        </div>
      </div>

      <form className="upload-card" onSubmit={submit}>
        <div className="card-heading">
          <div><span className="section-kicker">NEW ANALYSIS</span><h2>创建投稿项目</h2></div>
          <span className="secure-note"><ShieldCheck size={15} />原文不在本地持久化</span>
        </div>

        <button
          type="button"
          className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            selectFile(event.dataTransfer.files?.[0]);
          }}
        >
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".docx,.pdf,.txt,.md"
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
          {file ? (
            <>
              <span className="upload-icon success"><FileCheck2 size={26} /></span>
              <strong>{file.name}</strong>
              <small>{(file.size / 1024 / 1024).toFixed(2)} MB · 点击更换文件</small>
            </>
          ) : (
            <>
              <span className="upload-icon"><UploadCloud size={26} /></span>
              <strong>拖放论文到这里，或点击选择</strong>
              <small>支持 DOCX、PDF、TXT、Markdown，最大 15 MB</small>
            </>
          )}
        </button>

        <label className="ai-upload-toggle">
          <input
            type="checkbox"
            checked={useAI}
            onChange={(event) => setUseAI(event.target.checked)}
          />
          <span className="toggle-control" />
          <span>
            <strong>启用 DeepSeek V4 Pro 深度评估</strong>
            <small>开启后论文正文会发送至 DeepSeek 官方 API；关闭后仅执行本地规则检查。</small>
          </span>
        </label>

        <div className="form-grid">
          <label>
            <span>研究方向</span>
            <input value={researchField} onChange={(event) => setResearchField(event.target.value)} placeholder="例如：计算机科学" />
          </label>
          <label>
            <span>开放获取偏好</span>
            <select value={accessPreference} onChange={(event) => setAccessPreference(event.target.value)}>
              <option>不限</option><option>开放获取</option><option>混合模式</option>
            </select>
          </label>
          <label className="full-field">
            <span>补充关键词 <small>可选，用逗号分隔</small></span>
            <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="大模型，科研智能体，论文评估" />
          </label>
        </div>

        <div className="upload-actions">
          <button type="button" className="text-button" onClick={createDemo} disabled={busy !== ''}>
            {busy === 'demo' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}使用示例论文体验
          </button>
          <Button type="submit" loading={busy === 'upload'} disabled={!file} icon={ArrowRight}>解析并开始评估</Button>
        </div>
      </form>
    </div>
  );
}

function ProjectHeader({ project }) {
  return (
    <div className="project-header">
      <div>
        <div className="project-meta-line">
          <span className="file-pill"><FileText size={14} />{project.document.fileType}</span>
          <span>更新于 {formatDate(project.updatedAt)}</span>
          <span>·</span>
          <span>{project.status}</span>
        </div>
        <h1>{project.name}</h1>
      </div>
      <button className="icon-button"><MoreHorizontal size={20} /></button>
    </div>
  );
}

function WorkflowSteps({ activeStep, onChange, project }) {
  const available = [true, true, Boolean(project.selectedJournal || project.recommendations), Boolean(project.selectedJournal), true, true];
  return (
    <nav className="workflow-steps" aria-label="投稿流程">
      {steps.map((step, index) => {
        const Icon = step.icon;
        const complete = index < Math.min(project.stage, 6);
        return (
          <button
            key={step.label}
            className={`${activeStep === index ? 'active' : ''} ${complete ? 'complete' : ''}`}
            onClick={() => available[index] && onChange(index)}
            disabled={!available[index]}
          >
            <span className="step-icon">{complete ? <Check size={15} /> : <Icon size={16} />}</span>
            <span><small>0{index + 1}</small>{step.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function StageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="stage-heading">
      <div><span className="section-kicker">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>
      {action}
    </div>
  );
}

function AnalysisStage({ project, busy, runAction, setActiveStep }) {
  const { analysis, document } = project;
  const generateRecommendations = () =>
    runAction('recommend', () => api.recommend(project.id), 1);

  return (
    <div className="stage-content">
      <StageHeading
        eyebrow="MANUSCRIPT READINESS"
        title="稿件质量初评"
        description="从结构、贡献表达、可复现性、证据与写作五个维度进行投稿前自检。"
        action={
          <Button loading={busy === 'recommend'} onClick={project.recommendations ? () => setActiveStep(1) : generateRecommendations} icon={ArrowRight}>
            {project.recommendations ? '查看期刊匹配' : '生成期刊匹配'}
          </Button>
        }
      />

      <div className="analysis-grid">
        <article className="score-card surface-card">
          <div className="score-ring" style={{ '--score': `${analysis.overall * 3.6}deg` }}>
            <div><strong>{analysis.overall}</strong><span>/ 100</span></div>
          </div>
          <div className="score-copy">
            <span className="score-level">{analysis.level}</span>
            <h3>投稿准备度</h3>
            <p>{analysis.summary}</p>
            <small>评估可信度 {analysis.confidence}%</small>
          </div>
        </article>

        <article className="dimension-card surface-card">
          <div className="card-title-row"><h3>维度表现</h3><span>规则评估 v0.1</span></div>
          <div className="dimension-list">
            {Object.entries(analysis.scores).map(([key, score]) => (
              <div className="dimension-row" key={key}>
                <span>{scoreLabels[key]}</span>
                <div className="progress-track"><i style={{ width: `${score}%` }} /></div>
                <strong>{score}</strong>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="stats-row">
        <div><FileText size={18} /><span><strong>{document.wordCount.toLocaleString()}</strong>字词数</span></div>
        <div><LibraryBig size={18} /><span><strong>{document.referenceCount}</strong>参考文献</span></div>
        <div><ListChecks size={18} /><span><strong>{Object.values(document.detectedSections).filter(Boolean).length}/7</strong>核心章节</span></div>
        <div><Target size={18} /><span><strong>{document.keywords.length}</strong>关键词</span></div>
      </div>

      <DeepSeekAnalysisCard analysis={project.aiAnalysis} />

      <div className="two-column-layout">
        <article className="surface-card issues-card">
          <div className="card-title-row"><div><h3>优先改进项</h3><p>建议先处理高风险问题，再进入目标期刊适配。</p></div><span className="count-badge">{analysis.issues.length}</span></div>
          <div className="issue-list">
            {analysis.issues.map((issue) => (
              <div className="issue-item" key={issue.id}>
                <span className={`severity-dot severity-${issue.severity}`} />
                <div>
                  <div className="issue-title"><strong>{issue.title}</strong><span className={`severity-label severity-${issue.severity}`}>{severityLabels[issue.severity]}</span></div>
                  <p>{issue.detail}</p>
                  <span className="issue-action"><ArrowRight size={14} />{issue.action}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <aside className="right-stack">
          <article className="surface-card manuscript-card">
            <div className="card-title-row"><h3>解析结果</h3><span>{document.language}</span></div>
            <dl>
              <div><dt>文件</dt><dd>{document.filename}</dd></div>
              <div><dt>摘要</dt><dd>{document.abstract ? `${document.abstract.slice(0, 90)}…` : '未识别'}</dd></div>
              <div><dt>关键词</dt><dd>{document.keywords.join('、') || '未识别'}</dd></div>
            </dl>
          </article>
          <article className="surface-card strengths-card">
            <h3>已识别优势</h3>
            {analysis.strengths.map((strength) => <p key={strength}><CheckCircle2 size={16} />{strength}</p>)}
          </article>
          <div className="notice-card"><Info size={17} /><p>{analysis.notice}</p></div>
        </aside>
      </div>
    </div>
  );
}

function DeepSeekAnalysisCard({ analysis }) {
  if (!analysis) return null;
  if (analysis.status === 'error') {
    return (
      <div className="ai-error-card">
        <AlertCircle size={18} />
        <div><strong>DeepSeek 深度评估未完成</strong><p>{analysis.message}</p></div>
      </div>
    );
  }

  return (
    <article className="ai-analysis-card surface-card">
      <div className="ai-analysis-header">
        <div className="ai-model-mark"><Sparkles size={21} /></div>
        <div>
          <span className="section-kicker">AI SEMANTIC REVIEW</span>
          <h3>DeepSeek 学术深度评估</h3>
          <p>{analysis.overallAssessment}</p>
        </div>
        <div className="ai-model-meta">
          <span>{analysis.model}</span>
          <strong>{Math.round(analysis.confidence * 100)}%</strong>
          <small>模型信心</small>
        </div>
      </div>

      <div className="ai-contribution">
        <span><Target size={16} />核心贡献判断</span>
        <p>{analysis.centralContribution || '模型未形成明确的核心贡献判断。'}</p>
      </div>

      <div className="ai-review-columns">
        <div>
          <h4><CheckCircle2 size={16} />识别优势</h4>
          {analysis.strengths.map((item, index) => (
            <div className="ai-review-item" key={`strength-${index}`}>
              <strong>{item.point}</strong>
              {item.evidence && <p>{item.evidence}</p>}
            </div>
          ))}
        </div>
        <div>
          <h4><AlertCircle size={16} />主要学术风险</h4>
          {analysis.majorIssues.map((item, index) => (
            <div className="ai-review-item risk" key={`risk-${index}`}>
              <span>{item.category || '综合问题'}</span>
              <strong>{item.point}</strong>
              {item.evidence && <p>{item.evidence}</p>}
              {item.suggestion && <small><ArrowRight size={13} />{item.suggestion}</small>}
            </div>
          ))}
        </div>
      </div>

      {analysis.recommendedActions.length > 0 && (
        <div className="ai-actions">
          <strong>建议优先动作</strong>
          <ol>{analysis.recommendedActions.map((action) => <li key={action}>{action}</li>)}</ol>
        </div>
      )}
      <footer>
        <span>{analysis.notice}</span>
        {analysis.inputCoverage?.truncated && <small>首版分析使用了论文首尾 {analysis.inputCoverage.suppliedCharacters.toLocaleString()} 个字符</small>}
      </footer>
    </article>
  );
}

function JournalStage({ project, busy, runAction, patchCurrent, setActiveStep }) {
  const recommendations = project.recommendations;
  const generate = () => runAction('recommend', () => api.recommend(project.id));
  const select = (journal) =>
    patchCurrent({ selectedJournal: journal, status: `已选择 ${journal.name}`, stage: Math.max(project.stage, 2) }, `journal-${journal.id}`);

  if (!recommendations) {
    return <EmptyStage icon={Compass} title="生成候选期刊" description="结合论文主题、研究方向、关键词和当前准备度生成首批候选。" button="开始匹配" loading={busy === 'recommend'} onClick={generate} />;
  }

  return (
    <div className="stage-content">
      <StageHeading
        eyebrow="JOURNAL DISCOVERY"
        title="候选期刊匹配"
        description="规则模型先筛选候选，DeepSeek 再结合论文贡献、目标读者和证据准备度进行重排。"
        action={
          <div className="stage-actions">
            <Button variant="secondary" loading={busy === 'recommend'} onClick={generate} icon={RefreshCw}>重新匹配</Button>
            <Button disabled={!project.selectedJournal} onClick={() => setActiveStep(2)} icon={ArrowRight}>进入模拟审稿</Button>
          </div>
        }
      />
      <div className="catalog-notice journal-catalog-notice">
        <Info size={17} />
        <span>{recommendations.notice}</span>
        <div className="journal-catalog-summary">
          <strong>{recommendations.catalog?.size || '—'} 本</strong>
          <small>{recommendations.method === 'deepseek-assisted' ? `${recommendations.model} 辅助重排` : '规则匹配'}</small>
        </div>
      </div>
      {recommendations.aiError && <div className="catalog-notice warning"><AlertCircle size={17} /><span>{recommendations.aiError}</span></div>}
      <div className="journal-list">
        {recommendations.items.map((journal, index) => {
          const selected = project.selectedJournal?.id === journal.id;
          const fitBreakdown = journal.fitBreakdown || {
            scope: journal.topicalFit,
            audience: journal.audienceFit,
            evidence: journal.evidenceFit,
          };
          return (
            <article className={`journal-card ${selected ? 'selected' : ''}`} key={journal.id}>
              <div className="journal-rank">{String(index + 1).padStart(2, '0')}</div>
              <div className="journal-main">
                <div className="journal-title-row">
                  <div>
                    <h3>{journal.name}<span className="journal-title-ranks"><JournalRankBadges journal={journal} /></span></h3>
                    <p>{journal.publisher} · {journal.access}</p>
                    {journal.source?.url && (
                      <a className="journal-source" href={journal.source.url} target="_blank" rel="noreferrer">
                        <ExternalLink size={12} />官方范围来源 · 核对日期 {journal.source.checkedAt}
                      </a>
                    )}
                  </div>
                  <span className="match-score"><strong>{journal.matchScore}</strong><small>综合适配分</small></span>
                </div>
                <p className="journal-profile">{journal.profile}</p>
                <div className="journal-tags">{journal.fields.map((field) => <span key={field}>{field}</span>)}</div>
                <div className="fit-breakdown">
                  <span>范围匹配<strong>{fitBreakdown.scope ?? '—'}</strong></span>
                  <span>读者匹配<strong>{fitBreakdown.audience ?? '—'}</strong></span>
                  <span>证据准备<strong>{fitBreakdown.evidence ?? '—'}</strong></span>
                </div>
                <div className="journal-evidence">
                  <div><strong>推荐依据</strong>{journal.reasons.map((reason) => <p key={reason}><CheckCircle2 size={14} />{reason}</p>)}</div>
                  <div><strong>投稿前关注</strong>{journal.risks.length ? journal.risks.map((risk) => <p key={risk}><AlertCircle size={14} />{risk}</p>) : <p><CheckCircle2 size={14} />暂无高优先级结构风险</p>}</div>
                  <div><strong>建议动作</strong>{journal.preparationActions?.length ? journal.preparationActions.map((action) => <p key={action}><ArrowRight size={14} />{action}</p>) : <p><CheckCircle2 size={14} />进入官网核对文章类型和作者指南</p>}</div>
                </div>
              </div>
              <div className="journal-action">
                <Button variant={selected ? 'selected' : 'secondary'} loading={busy === `journal-${journal.id}`} onClick={() => select(journal)} icon={selected ? Check : Target}>
                  {selected ? '已选定' : '选为目标期刊'}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ReviewStage({ project, busy, runAction, setActiveStep }) {
  if (!project.selectedJournal) return <EmptyStage icon={Target} title="尚未选择目标期刊" description="模拟审稿需要依据目标期刊范围生成适配性意见。" button="返回期刊匹配" onClick={() => setActiveStep(1)} />;
  const generate = () => runAction('review', () => api.review(project.id));
  if (!project.review) return <EmptyStage icon={ClipboardCheck} title={`为 ${project.selectedJournal.name} 生成模拟审稿`} description="将质量初评问题转换为结构化审稿意见和可执行修改任务。" button="生成模拟审稿" loading={busy === 'review'} onClick={generate} />;

  return (
    <div className="stage-content">
      <StageHeading eyebrow="PRE-SUBMISSION REVIEW" title="模拟审稿结果" description={`面向 ${project.selectedJournal.name} 的投稿前风险检查。`} action={<Button onClick={() => setActiveStep(3)} icon={ArrowRight}>制定修改与材料</Button>} />
      <div className="review-summary surface-card">
        <div className="recommendation-mark"><ClipboardCheck size={23} /></div>
        <div><span>建议结论</span><h3>{project.review.recommendation}</h3><p>{project.review.summary}</p></div>
        <span className="review-count"><strong>{project.review.comments.length - 1}</strong>项具体问题</span>
      </div>
      <div className="review-list">
        {project.review.comments.map((comment, index) => (
          <article className="review-comment surface-card" key={comment.id}>
            <div className="comment-number">{index === 0 ? '总' : index}</div>
            <div className="comment-body">
              <div className="comment-meta"><span>{comment.type}</span><span>{comment.category}</span><small>{comment.source}</small></div>
              <h3>{comment.comment}</h3>
              <div className="review-request"><ArrowRight size={15} /><span><strong>建议处理：</strong>{comment.request}</span></div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function MaterialsStage({ project, busy, runAction, patchCurrent, setActiveStep }) {
  const generate = () => runAction('materials', () => api.materials(project.id));

  const toggleTask = (id) => {
    const review = {
      ...project.review,
      tasks: project.review.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task),
    };
    patchCurrent({ review }, 'task');
  };

  const toggleCheck = (id) => {
    const materials = {
      ...project.materials,
      checklist: project.materials.checklist.map((item) => item.id === id ? { ...item, checked: !item.checked } : item),
    };
    patchCurrent({ materials }, 'checklist');
  };

  if (!project.materials) {
    return <EmptyStage icon={FileCheck2} title="生成投稿准备包" description="汇总修改任务，并生成 Cover Letter、Highlights 与投稿检查清单草稿。" button="生成投稿材料" loading={busy === 'materials'} onClick={generate} />;
  }

  const completedTasks = project.review?.tasks.filter((task) => task.completed).length ?? 0;
  return (
    <div className="stage-content">
      <StageHeading eyebrow="SUBMISSION PACKAGE" title="修改任务与投稿材料" description="逐项完成修改，并在正式投稿前由作者核对所有生成内容。" action={<Button onClick={() => setActiveStep(4)} icon={ArrowRight}>处理审稿意见</Button>} />
      <div className="materials-layout">
        <article className="surface-card task-card">
          <div className="card-title-row"><div><h3>修改任务</h3><p>{completedTasks}/{project.review?.tasks.length ?? 0} 已完成</p></div><span className="completion-ring">{Math.round((completedTasks / Math.max(project.review?.tasks.length ?? 1, 1)) * 100)}%</span></div>
          <div className="task-list">
            {project.review?.tasks.map((task) => (
              <button key={task.id} onClick={() => toggleTask(task.id)} className={task.completed ? 'done' : ''}>
                {task.completed ? <CheckCircle2 size={19} /> : <Circle size={19} />}
                <span><strong>{task.title}</strong><small>{task.category} · {task.priority}优先级</small></span>
              </button>
            ))}
          </div>
        </article>
        <div className="materials-stack">
          <TextArtifact title="Cover Letter 草稿" content={project.materials.coverLetter} />
          <article className="surface-card highlights-card">
            <div className="card-title-row"><h3>Highlights</h3><CopyButton content={project.materials.highlights.join('\n')} /></div>
            <ol>{project.materials.highlights.map((item) => <li key={item}>{item}</li>)}</ol>
          </article>
          <article className="surface-card checklist-card">
            <div className="card-title-row"><h3>投稿检查清单</h3><span>{project.materials.checklist.filter((item) => item.checked).length}/{project.materials.checklist.length}</span></div>
            {project.materials.checklist.map((item) => (
              <button key={item.id} className={item.checked ? 'checked' : ''} onClick={() => toggleCheck(item.id)}>
                {item.checked ? <CheckCircle2 size={18} /> : <Circle size={18} />}{item.label}
              </button>
            ))}
          </article>
        </div>
      </div>
    </div>
  );
}

function RebuttalStage({ project, busy, runAction, patchCurrent, setActiveStep }) {
  const [comments, setComments] = useState('');
  const generate = () => runAction('rebuttal', () => api.rebuttal(project.id, comments));
  const toggle = (id) => {
    const rebuttal = {
      ...project.rebuttal,
      items: project.rebuttal.items.map((item) => item.id === id ? { ...item, completed: !item.completed } : item),
    };
    patchCurrent({ rebuttal }, 'rebuttal-save');
  };

  return (
    <div className="stage-content">
      <StageHeading eyebrow="REVIEW RESPONSE" title="Rebuttal 工作台" description="粘贴真实审稿意见，拆解问题、制定修改动作并生成逐条回复草稿。" action={project.rebuttal ? <Button onClick={() => setActiveStep(5)} icon={ArrowRight}>查看流程归档</Button> : null} />
      {!project.rebuttal ? (
        <div className="rebuttal-input-layout">
          <article className="surface-card reviewer-input-card">
            <div className="card-title-row"><div><h3>导入审稿意见</h3><p>支持编号、项目符号或空行分隔。</p></div><MessageSquareReply size={22} /></div>
            <textarea value={comments} onChange={(event) => setComments(event.target.value)} placeholder={'1. The contribution is not clearly distinguished from prior work.\n\n2. Please add an ablation study and report statistical significance.\n\n3. 请进一步说明数据集的构建和划分方式。'} />
            <div className="textarea-footer"><span>{comments.length} 字符</span><Button loading={busy === 'rebuttal'} disabled={comments.trim().length < 8} onClick={generate} icon={Sparkles}>解析并生成回复</Button></div>
          </article>
          <aside className="rebuttal-guide">
            <h3>生成原则</h3>
            <p><span>01</span>逐条保留原始意见，避免遗漏。</p>
            <p><span>02</span>先解释审稿人关切，再制定修改。</p>
            <p><span>03</span>回复必须标注真实页码、行号与证据。</p>
            <div><AlertCircle size={17} />系统不会替作者虚构实验、数据或修改结果。</div>
          </aside>
        </div>
      ) : (
        <>
          <div className="catalog-notice warning"><AlertCircle size={17} /><span>{project.rebuttal.notice}</span></div>
          <div className="rebuttal-list">
            {project.rebuttal.items.map((item, index) => (
              <article className={`rebuttal-item surface-card ${item.completed ? 'completed' : ''}`} key={item.id}>
                <div className="rebuttal-topline"><span>COMMENT {String(index + 1).padStart(2, '0')}</span><button onClick={() => toggle(item.id)}>{item.completed ? <CheckCircle2 size={18} /> : <Circle size={18} />}{item.completed ? '已核实' : '标记为已核实'}</button></div>
                <blockquote>{item.reviewerComment}</blockquote>
                <div className="interpretation"><strong>意图解析</strong><p>{item.interpretation}</p><strong>修改动作</strong><p>{item.action}</p></div>
                <div className="response-draft"><div><strong>回复草稿</strong><CopyButton content={item.response} /></div><p>{item.response}</p></div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ArchiveStage({ project, busy, patchCurrent }) {
  const taskTotal = project.review?.tasks.length ?? 0;
  const taskDone = project.review?.tasks.filter((task) => task.completed).length ?? 0;
  const rebuttalTotal = project.rebuttal?.items.length ?? 0;
  const rebuttalDone = project.rebuttal?.items.filter((item) => item.completed).length ?? 0;
  const archived = project.status === '流程已归档';
  const archive = () => patchCurrent({ status: '流程已归档', stage: 6 }, 'archive');

  return (
    <div className="stage-content archive-stage">
      <div className="archive-hero">
        <div className={`archive-icon ${archived ? 'done' : ''}`}>{archived ? <Check size={30} /> : <Database size={30} />}</div>
        <span className="section-kicker">WORKFLOW RECORD</span>
        <h2>{archived ? '本轮投稿流程已归档' : '保存本轮投稿决策记录'}</h2>
        <p>归档质量评估、目标期刊、修改任务、投稿材料和审稿回复，作为后续个性化推荐的数据基础。</p>
      </div>
      <div className="archive-summary">
        <article><span><ScanSearch size={18} />质量评估</span><strong>{project.analysis.overall}</strong><small>{project.analysis.level}</small></article>
        <article><span><Compass size={18} />目标期刊</span><strong className="text-value">{project.selectedJournal?.name || '未选择'}</strong><small>{project.selectedJournal?.publisher || '—'}</small></article>
        <article><span><ListChecks size={18} />修改任务</span><strong>{taskDone}/{taskTotal}</strong><small>已完成</small></article>
        <article><span><MessageSquareReply size={18} />审稿回复</span><strong>{rebuttalDone}/{rebuttalTotal}</strong><small>已核实</small></article>
      </div>
      <div className="archive-data surface-card">
        <div><Database size={21} /><span><strong>本次将保存</strong><small>论文元数据、评分、期刊选择、任务状态、生成材料与作者确认记录</small></span></div>
        <div><ShieldCheck size={21} /><span><strong>隐私边界</strong><small>MVP 不持久化原始论文全文；后续接入账户体系后再配置数据保留策略</small></span></div>
      </div>
      {!archived && <Button loading={busy === 'archive'} onClick={archive} icon={Database}>确认归档本轮流程</Button>}
    </div>
  );
}

function EmptyStage({ icon: Icon, title, description, button, onClick, loading }) {
  return (
    <div className="empty-stage">
      <span><Icon size={28} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      <Button onClick={onClick} loading={loading} icon={ArrowRight}>{button}</Button>
    </div>
  );
}

function CopyButton({ content }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <button className="copy-button" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button>;
}

function TextArtifact({ title, content }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="surface-card text-artifact">
      <div className="card-title-row"><h3>{title}</h3><CopyButton content={content} /></div>
      <pre className={expanded ? 'expanded' : ''}>{content}</pre>
      <button className="expand-button" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起全文' : '展开全文'}</button>
    </article>
  );
}

export default App;
