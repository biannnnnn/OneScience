import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileCheck2,
  FileText,
  FolderOpen,
  Gauge,
  Info,
  LayoutDashboard,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  UploadCloud,
} from 'lucide-react';
import { api } from './api.js';

const steps = [
  { label: '关键词与参数', icon: Search },
  { label: '候选期刊', icon: Target },
  { label: '近期论文评分', icon: BarChart3 },
  { label: '录用判断', icon: Gauge },
];

const benchmarkLabels = {
  above_recent_baseline: '高于近期论文基线',
  near_recent_baseline: '接近期刊论文基线',
  below_recent_baseline: '低于近期论文基线',
  insufficient_reference_data: '近期样本不足',
};

const scoringModels = [
  { id: 'ranker-8b', label: '8B 小模型' },
  { id: 'ranker-3b', label: '3B 小模型' },
  { id: 'ranker-0.6b', label: '0.6B 小模型' },
  { id: 'deepseek', label: 'DeepSeek 大模型' },
];

function scoringLabel(flow) {
  return flow?.scoring?.label || '8B Ranker';
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
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
  const [project, setProject] = useState(null);
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
      setProject(result);
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
    const result = await runAction('open', () => api.getProject(id));
    setActiveStep(result?.reviewFlow ? 3 : 0);
  };

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        projects={projects}
        currentId={project?.id}
        onOpen={openProject}
        onNew={() => { setProject(null); setActiveStep(0); setError(''); }}
      />
      <main className="main-shell">
        <Topbar project={project} modelStatus={modelStatus} onToggle={() => setSidebarOpen((value) => !value)} />
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} /><span>{error}</span>
            <button onClick={() => setError('')} aria-label="关闭错误提示">×</button>
          </div>
        )}
        {!project ? (
          <UploadWorkspace
            busy={busy}
            runAction={runAction}
            onCreated={(created) => { setProject(created); setActiveStep(0); refreshProjects(); }}
          />
        ) : (
          <div className="workspace">
            <ProjectHeader project={project} />
            <WorkflowSteps activeStep={activeStep} onChange={setActiveStep} project={project} />
            <section className="stage-panel">
              {activeStep === 0 && <KeywordStage project={project} busy={busy} runAction={runAction} />}
              {activeStep === 1 && <JournalCandidatesStage project={project} setActiveStep={setActiveStep} />}
              {activeStep === 2 && <RecentPapersStage project={project} setActiveStep={setActiveStep} />}
              {activeStep === 3 && <DecisionStage project={project} busy={busy} runAction={runAction} />}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Sidebar({ open, onToggle, projects, currentId, onOpen, onNew }) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><BookOpen size={22} /></div>
        {open && <div className="brand-copy"><strong>OneScience</strong><span>Review Intelligence</span></div>}
        <button className="icon-button sidebar-toggle" onClick={onToggle} aria-label="切换侧栏"><LayoutDashboard size={18} /></button>
      </div>
      <div className="sidebar-body">
        <Button variant="sidebar" icon={Plus} onClick={onNew}>新建审稿项目</Button>
        {open && (
          <>
            <div className="sidebar-section-label">当前流程</div>
            <div className="side-nav active"><FolderOpen size={17} />审稿项目</div>
            <div className="sidebar-section-label project-label">最近项目</div>
            <div className="project-list">
              {projects.length === 0 && <p className="sidebar-empty">还没有项目，上传论文开始分析。</p>}
              {projects.slice(0, 8).map((item) => (
                <button key={item.id} className={`project-link ${currentId === item.id ? 'selected' : ''}`} onClick={() => onOpen(item.id)}>
                  <span className="project-file-icon"><FileText size={15} /></span>
                  <span className="project-link-copy"><strong>{item.name}</strong><small>{item.status} · {formatDate(item.updatedAt)}</small></span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {open && <div className="sidebar-footer"><ShieldCheck size={17} /><div><strong>隐私模式</strong><span>原始论文不持久化保存</span></div></div>}
    </aside>
  );
}

function Topbar({ project, modelStatus, onToggle }) {
  const rankerReady = modelStatus?.ranker?.available;
  const webReady = modelStatus?.scholarlySearch?.configured;
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={onToggle}><LayoutDashboard size={18} /></button>
      <div className="breadcrumb"><span>当前审稿流程</span>{project && <><ChevronRight size={14} /><strong>{project.name}</strong></>}</div>
      <div className="topbar-meta">
        <span className="system-status"><span className={`status-dot ${rankerReady && webReady ? 'model-ready' : ''}`} />{rankerReady ? 'Ranker 已连接' : '评分降级模式'} · {webReady ? 'Web 检索已连接' : 'Web 待配置'}</span>
        <div className="avatar">OS</div>
      </div>
    </header>
  );
}

function UploadWorkspace({ busy, runAction, onCreated }) {
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

  return (
    <div className="welcome-page">
      <div className="welcome-hero">
        <div className="eyebrow"><Sparkles size={15} />以当前审稿流程为准</div>
        <h1>用近期同刊论文<br /><em>校准投稿判断</em></h1>
        <p>上传论文后提取关键词，从 Web 发现有梯度的候选期刊，逐刊检索近期相似论文并由自训练 NAIPv2 Ranker 评分，最后比较稿件与期刊基线。</p>
        <div className="hero-points">
          <span><CheckCircle2 size={16} />k 个差异化期刊</span>
          <span><CheckCircle2 size={16} />每刊 n 篇近期论文</span>
          <span><CheckCircle2 size={16} />期刊条件录用判断</span>
        </div>
      </div>
      <form className="upload-card" onSubmit={submit}>
        <div className="card-heading"><div><span className="section-kicker">NEW REVIEW</span><h2>上传待审论文</h2></div><span className="secure-note"><ShieldCheck size={15} />原文不落盘</span></div>
        <button
          type="button"
          className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); setFile(event.dataTransfer.files?.[0] || null); }}
        >
          <input ref={inputRef} hidden type="file" accept=".docx,.pdf,.txt,.md" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          {file ? <><span className="upload-icon success"><FileCheck2 size={26} /></span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB · 点击更换</small></> : <><span className="upload-icon"><UploadCloud size={26} /></span><strong>拖放论文到这里，或点击选择</strong><small>DOCX、PDF、TXT、Markdown，最大 15 MB</small></>}
        </button>
        <label className="ai-upload-toggle">
          <input type="checkbox" checked={useAI} onChange={(event) => setUseAI(event.target.checked)} /><span className="toggle-control" />
          <span><strong>启用大模型语义画像</strong><small>用于补充关键词和候选期刊重排；论文评分由自训练 NAIPv2 Ranker 完成。</small></span>
        </label>
        <div className="form-grid">
          <label><span>研究方向</span><input value={researchField} onChange={(event) => setResearchField(event.target.value)} placeholder="例如：人工智能" /></label>
          <label><span>开放获取偏好</span><select value={accessPreference} onChange={(event) => setAccessPreference(event.target.value)}><option>不限</option><option>开放获取</option><option>混合模式</option></select></label>
          <label className="full-field"><span>补充关键词 <small>可选</small></span><input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="大模型，科研智能体，论文评估" /></label>
        </div>
        <div className="upload-actions">
          <button type="button" className="text-button" onClick={createDemo} disabled={busy !== ''}>{busy === 'demo' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}使用示例论文</button>
          <Button type="submit" loading={busy === 'upload'} disabled={!file} icon={ArrowRight}>解析论文</Button>
        </div>
      </form>
    </div>
  );
}

function ProjectHeader({ project }) {
  return (
    <div className="project-header">
      <div><div className="project-meta-line"><span className="file-pill"><FileText size={14} />{project.document.fileType}</span><span>更新于 {formatDate(project.updatedAt)}</span><span>·</span><span>{project.status}</span></div><h1>{project.name}</h1></div>
    </div>
  );
}

function WorkflowSteps({ activeStep, onChange, project }) {
  const hasFlow = Boolean(project.reviewFlow);
  return (
    <nav className="workflow-steps current-review-steps" aria-label="当前审稿流程">
      {steps.map((step, index) => {
        const Icon = step.icon;
        const available = index === 0 || hasFlow;
        const complete = hasFlow && index < 3;
        return (
          <button key={step.label} className={`${activeStep === index ? 'active' : ''} ${complete ? 'complete' : ''}`} onClick={() => available && onChange(index)} disabled={!available}>
            <span className="step-icon">{complete ? <Check size={15} /> : <Icon size={16} />}</span><span><small>0{index + 1}</small>{step.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function StageHeading({ eyebrow, title, description, action }) {
  return <div className="stage-heading"><div><span className="section-kicker">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function KeywordStage({ project, busy, runAction }) {
  const defaults = project.reviewFlow?.hyperparameters || { k: 5, n: 3, recentYears: 3 };
  const [k, setK] = useState(defaults.k);
  const [n, setN] = useState(defaults.n);
  const [recentYears, setRecentYears] = useState(defaults.recentYears);
  const [scoringModel, setScoringModel] = useState(defaults.scoringModel || 'ranker-8b');
  const run = () => runAction('review-flow', () => api.runReviewFlow(project.id, { k, n, recentYears, scoringModel, useAI: true }), 1);
  const keywords = project.reviewFlow?.keywords || [...new Set([...(project.document.keywords || []), ...(project.profile?.keywords || []), project.profile?.researchField].filter(Boolean))];
  return (
    <div className="stage-content">
      <StageHeading eyebrow="KEYWORDS & HYPERPARAMETERS" title="关键词与检索参数" description="确认论文画像，并设置候选期刊数 k、每本期刊的近期论文数 n。" action={<Button loading={busy === 'review-flow'} onClick={run} icon={project.reviewFlow ? RefreshCw : ArrowRight}>{project.reviewFlow ? '重新运行当前流程' : '运行当前审稿流程'}</Button>} />
      <div className="review-config-grid">
        <article className="surface-card keyword-card">
          <div className="card-title-row"><div><h3>已提取关键词</h3><p>来自论文关键词、用户补充信息与语义画像。</p></div><span>{keywords.length} 个</span></div>
          <div className="keyword-cloud">{keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div>
          <dl className="document-facts"><div><dt>标题</dt><dd>{project.document.title}</dd></div><div><dt>摘要</dt><dd>{project.document.abstract || '未识别摘要'}</dd></div><div><dt>参考文献</dt><dd>{project.document.referenceCount} 条</dd></div><div><dt>解析方式</dt><dd>{project.document.extractionMethod === 'markitdown-pdf' ? 'MarkItDown PDF → Markdown' : project.document.extractionMethod || '内置解析器'}</dd></div></dl>
          {project.document.extractionWarning && <div className="inline-warning"><AlertCircle size={15} />{project.document.extractionWarning}</div>}
        </article>
        <article className="surface-card parameter-card">
          <h3>超参数</h3>
          <label><span>候选期刊数 k</span><input type="number" min="2" max="8" value={k} onChange={(event) => setK(Number(event.target.value))} /><small>系统尽量覆盖高挑战、稳健与广覆盖梯度。</small></label>
          <label><span>每刊近期论文数 n</span><input type="number" min="1" max="8" value={n} onChange={(event) => setN(Number(event.target.value))} /><small>论文越多，期刊分数基线越稳定，推理耗时也越长。</small></label>
          <label><span>近期窗口</span><select value={recentYears} onChange={(event) => setRecentYears(Number(event.target.value))}><option value="2">近 2 年</option><option value="3">近 3 年</option><option value="5">近 5 年</option></select></label>
          <label className="scoring-model-field"><span>最终评分模型</span><select value={scoringModel} onChange={(event) => setScoringModel(event.target.value)}>{scoringModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><small>系统会等待所选模型完成逐刊批量评分；DeepSeek 会产生外部 API 调用。</small></label>
          <div className="parameter-cost"><Info size={16} /><span>一次运行会执行 {k} 个批量评分任务，共比较最多 {k * n} 篇参考论文；当前选择：{scoringModels.find((model) => model.id === scoringModel)?.label}。</span></div>
        </article>
      </div>
      {project.reviewFlow && <div className="catalog-notice"><Info size={17} /><span>上次运行：k={defaults.k}，n={defaults.n}，{defaults.recentYears} 年窗口，评分模型为 {scoringLabel(project.reviewFlow)}。{project.reviewFlow.notice}</span></div>}
    </div>
  );
}

function RankBadges({ journal }) {
  return (
    <div className="rank-badges">
      {journal.metrics?.ccf && <span>{journal.metrics.ccf}</span>}
      {journal.metrics?.cas && <span>{journal.metrics.cas}</span>}
      {journal.metrics?.impactFactor !== null && <span>JIF {journal.metrics.impactFactor} ({journal.metrics.impactFactorYear})</span>}
      {journal.prestigeBasis === 'openalex-approx' && <span>影响力梯度（非 JIF）</span>}
    </div>
  );
}

function JournalCandidatesStage({ project, setActiveStep }) {
  const flow = project.reviewFlow;
  if (!flow) return <EmptyFlow onBack={() => setActiveStep(0)} />;
  return (
    <div className="stage-content">
      <StageHeading eyebrow="DISTINCT JOURNAL SET" title={`${flow.journals.length} 本差异化候选期刊`} description="主题适配之外，同时呈现 JIF、CCF、中科院分区与 OpenAlex 来源指标；没有权威值时明确留空。" action={<Button onClick={() => setActiveStep(2)} icon={ArrowRight}>查看近期论文评分</Button>} />
      <div className="catalog-notice"><Info size={17} /><span>{flow.discovery.diversityPolicy}。发现方法：{flow.discovery.method}{flow.discovery.model ? ` · ${flow.discovery.model}` : ''}。</span></div>
      {flow.discovery.llmError && <div className="catalog-notice warning"><AlertCircle size={17} /><span>大模型重排降级：{flow.discovery.llmError}</span></div>}
      <div className="candidate-grid">
        {flow.journals.map(({ journal, retrieval }, index) => (
          <article className="surface-card candidate-card" key={journal.id}>
            <div className="candidate-top"><span className={`prestige-band ${journal.prestigeBand}`}>{journal.prestigeLabel}</span><span className="candidate-index">0{index + 1}</span></div>
            <h3>{journal.name}</h3><p className="candidate-publisher">{journal.publisher} · {journal.access}</p>
            <RankBadges journal={journal} />
            <div className="metric-strip"><span><small>主题适配</small><strong>{journal.matchScore}</strong></span><span><small>OpenAlex 2yr</small><strong>{journal.metrics.openAlexTwoYearMeanCitedness ?? '—'}</strong></span><span><small>近期论文</small><strong>{project.reviewFlow.hyperparameters.n}</strong></span></div>
            <p className="candidate-profile">{journal.profile}</p>
            <div className="candidate-reasons">{journal.reasons.slice(0, 3).map((reason) => <span key={reason}><CheckCircle2 size={14} />{reason}</span>)}</div>
            <footer>{journal.source?.url && <a href={journal.source.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />{journal.openAlexId ? 'OpenAlex Source' : '期刊官方范围'}</a>}{!journal.openAlexId && retrieval.source?.openAlexUrl && <a href={retrieval.source.openAlexUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />OpenAlex Source</a>}</footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function RecentPapersStage({ project, setActiveStep }) {
  const flow = project.reviewFlow;
  if (!flow) return <EmptyFlow onBack={() => setActiveStep(0)} />;
  return (
    <div className="stage-content">
      <StageHeading eyebrow="RECENT PAPERS & SELECTED SCORER" title="近期相似论文评分" description={`OpenAlex 按期刊、日期和关键词检索；${scoringLabel(flow)} 仅使用标题与摘要，对稿件和参考论文做同尺度质量排序。`} action={<Button onClick={() => setActiveStep(3)} icon={ArrowRight}>查看投稿判断</Button>} />
      {!flow.services?.scorer?.available && <div className="catalog-notice warning"><AlertCircle size={17} /><span>{scoringLabel(flow)} 未连接：参考论文当前只显示检索降级分，不代表论文质量。配置所选评分服务后重新运行即可获得模型评分。</span></div>}
      <div className="paper-journal-stack">
        {flow.journals.map(({ journal, referencePapers, retrieval }) => (
          <section className="surface-card paper-journal-group" key={journal.id}>
            <header><div><span className={`prestige-band ${journal.prestigeBand}`}>{journal.prestigeLabel}</span><h3>{journal.name}</h3></div><span>{referencePapers.length}/{flow.hyperparameters.n} 篇</span></header>
            {retrieval.error && <div className="inline-warning"><AlertCircle size={15} />{retrieval.error}</div>}
            {referencePapers.length ? (
              <div className="reference-paper-list">
                {referencePapers.map((paper) => (
                  <article key={paper.id}>
                    <div className="paper-score"><strong>{paper.modelScore.score}</strong><small>{paper.modelScore.modelTrace ? `${scoringLabel(flow)} 分` : '降级分'}</small></div>
                    <div><span className="paper-meta">{paper.year} · {paper.authors.slice(0, 3).join('、') || '作者信息未提供'}</span><h4><a href={paper.url} target="_blank" rel="noreferrer">{paper.title}<ExternalLink size={12} /></a></h4><p>{paper.modelScore.rationale}</p>{paper.scoringError && <small className="score-error">评分降级：{paper.scoringError}</small>}</div>
                  </article>
                ))}
              </div>
            ) : <div className="empty-papers">未获取到满足期刊、时间与主题条件的公开论文元数据。</div>}
          </section>
        ))}
      </div>
    </div>
  );
}

function DecisionStage({ project, busy, runAction }) {
  const flow = project.reviewFlow;
  if (!flow) return <EmptyFlow />;
  const rerun = () => runAction('review-flow', () => api.runReviewFlow(project.id, { ...flow.hyperparameters, useAI: true }), 3);
  return (
    <div className="stage-content">
      <StageHeading eyebrow="MODEL BENCHMARK" title="稿件与同刊论文对比" description={`将稿件的 ${scoringLabel(flow)} 排序分与每本候选期刊的近期相似论文分布比较，判断是否达到该刊公开论文基线。`} action={<Button variant="secondary" loading={busy === 'review-flow'} onClick={rerun} icon={RefreshCw}>重新运行</Button>} />
      <div className="decision-grid">
        {flow.journals.map(({ journal, manuscriptScore, comparison, scoringError }) => {
          const calibrated = comparison.isCalibratedProbability;
          const label = calibrated ? ({ accept: '倾向录用', borderline: '边界样本', reject: '倾向拒绝' }[comparison.decision] || comparison.decision) : benchmarkLabels[comparison.benchmarkVerdict];
          const tone = calibrated ? comparison.decision : comparison.benchmarkVerdict;
          return (
            <article className="surface-card decision-card" key={journal.id}>
              <header><div><span className={`prestige-band ${journal.prestigeBand}`}>{journal.prestigeLabel}</span><h3>{journal.name}</h3><RankBadges journal={journal} /></div><div className="manuscript-score"><strong>{manuscriptScore.score}</strong><small>稿件 {scoringLabel(flow)} 分</small></div></header>
              <div className={`decision-verdict ${tone}`}><Gauge size={20} /><div><small>{calibrated ? '校准分类器判断' : '相对基线判断'}</small><strong>{label || '暂无判断'}</strong></div>{calibrated && <span>{Math.round(comparison.acceptancePrediction.acceptance_probability * 100)}%</span>}</div>
              <div className="benchmark-scale"><span><small>近期 P25</small><strong>{comparison.recentPaperLowerQuartile ?? '—'}</strong></span><span><small>近期中位数</small><strong>{comparison.recentPaperMedian ?? '—'}</strong></span><span><small>稿件差值</small><strong>{comparison.scoreDelta === null ? '—' : `${comparison.scoreDelta >= 0 ? '+' : ''}${comparison.scoreDelta}`}</strong></span><span><small>样本数</small><strong>{comparison.recentPaperCount}</strong></span></div>
              <p className="decision-rationale">{manuscriptScore.rationale}</p>
              {manuscriptScore.strengths.length > 0 && <div className="factor-list positive"><strong>正向因素</strong>{manuscriptScore.strengths.map((item) => <span key={item}><CheckCircle2 size={13} />{item}</span>)}</div>}
              {manuscriptScore.risks.length > 0 && <div className="factor-list risk"><strong>主要风险</strong>{manuscriptScore.risks.map((item) => <span key={item}><AlertCircle size={13} />{item}</span>)}</div>}
              {scoringError && <div className="inline-warning"><AlertCircle size={15} />{scoringLabel(flow)} 评分降级：{scoringError}</div>}
              <footer>{comparison.notice}</footer>
            </article>
          );
        })}
      </div>
      <div className="catalog-notice"><Info size={17} /><span>{flow.notice} 期刊指标只用于构造有区分度的候选集，不作为稿件学术质量的替代变量。</span></div>
    </div>
  );
}

function EmptyFlow({ onBack }) {
  return <div className="empty-stage"><Search size={32} /><h2>尚未运行当前审稿流程</h2><p>请先确认关键词与 k/n 参数，再执行候选期刊检索和论文评分。</p>{onBack && <Button onClick={onBack}>返回参数设置</Button>}</div>;
}

export default App;
