const catalogUrl = 'https://www.ccf.org.cn/ccftjgjxskwml/';

function ccfJournal({ tier, id, name, englishName, cn, language, organizer, fields, keywords = [] }) {
  const publisher = organizer.split(/[、；;]/)[0];
  return {
    id,
    name,
    englishName,
    publisher,
    organizer,
    access: '以官方政策为准',
    fields,
    keywords: [...fields, ...keywords, name, englishName].filter(Boolean),
    audience: fields.slice(0, 2).map((field) => `${field}研究者`),
    evidencePreferences: tier === 'CCF-T1'
      ? ['显著原创贡献', '严谨理论或实验验证', '广泛学术影响']
      : ['清晰技术贡献', '充分实验验证', '明确应用或研究价值'],
    profile: `${name}入选 CCF 2025 计算领域高质量科技期刊分级目录 ${tier.replace('CCF-', '')} 类，主要覆盖${fields.join('、')}等方向。具体征稿范围和投稿政策请以期刊官网为准。`,
    ccfTier: tier,
    cn,
    language,
    catalog: 'CCF 2025 计算领域高质量科技期刊分级目录',
    source: {
      label: 'CCF 2025 高质量科技期刊分级目录',
      url: catalogUrl,
    },
  };
}

export const ccfT1T2Journals = [
  ccfJournal({
    tier: 'CCF-T1', id: 'bdma', name: '大数据挖掘与分析', englishName: 'Big Data Mining and Analytics',
    cn: '10-1514/G2', language: '英文', organizer: '清华大学',
    fields: ['大数据', '数据挖掘', '人工智能'], keywords: ['big data', 'data mining', 'machine learning'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'cje', name: '电子学报（英文）', englishName: 'Chinese Journal of Electronics',
    cn: '10-1284/TN', language: '英文', organizer: '中国电子学会、电子工业出版社',
    fields: ['电子技术', '信息处理', '通信技术'], keywords: ['electronics', 'signal processing', 'communications'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'cybersecurity', name: '网络空间安全科学与技术（英文）', englishName: 'Cybersecurity',
    cn: '10-1537/TN', language: '英文', organizer: '中国科学院信息工程研究所、中国科技出版传媒股份有限公司',
    fields: ['网络安全', '密码学', '隐私保护'], keywords: ['cybersecurity', 'cryptography', 'privacy'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'frontiers-computer-science', name: '计算机科学前沿（英文版）', englishName: 'Frontiers of Computer Science',
    cn: '10-1014/TP', language: '英文', organizer: '高等教育出版社有限公司、北京航空航天大学',
    fields: ['计算机科学', '人工智能', '软件系统'], keywords: ['computer science', 'artificial intelligence', 'software systems'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'fitee', name: '信息与电子工程前沿（英文）', englishName: 'Frontiers of Information Technology & Electronic Engineering',
    cn: '33-1389/TP', language: '英文', organizer: '中国工程院、浙江大学',
    fields: ['信息技术', '电子工程', '计算机工程'], keywords: ['information technology', 'electronic engineering', 'computer engineering'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'jas', name: '自动化学报（英文版）', englishName: 'IEEE/CAA Journal of Automatica Sinica',
    cn: '10-1193/TP', language: '英文', organizer: '中国自动化学会、中国科学院自动化研究所、中国科技出版传媒股份有限公司',
    fields: ['自动化', '控制科学', '人工智能'], keywords: ['automation', 'control', 'artificial intelligence', 'robotics'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'jcst', name: '计算机科学技术学报（英文）', englishName: 'Journal of Computer Science and Technology',
    cn: '11-2296/TP', language: '英文', organizer: '中国科学院计算技术研究所、中国计算机学会',
    fields: ['计算机科学', '计算机系统', '人工智能'], keywords: ['computer science', 'computer systems', 'artificial intelligence'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'science-china-information-sciences', name: '中国科学：信息科学（英文版）', englishName: 'SCIENCE CHINA Information Sciences',
    cn: '11-5847/TP', language: '英文', organizer: '中国科学院、国家自然科学基金委员会',
    fields: ['信息科学', '计算机科学', '通信技术'], keywords: ['information sciences', 'computer science', 'communications'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'jeit', name: '电子与信息学报', englishName: 'Journal of Electronics & Information Technology',
    cn: '11-4494/TN', language: '中文', organizer: '中国科学院空天信息创新研究院、国家自然科学基金委员会信息科学部',
    fields: ['电子技术', '信息处理', '通信技术'], keywords: ['信号处理', '雷达', '电子信息'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'acta-electronica-sinica', name: '电子学报', englishName: 'Acta Electronica Sinica',
    cn: '11-2087/TN', language: '中文', organizer: '中国电子学会',
    fields: ['电子技术', '信息处理', '计算机工程'], keywords: ['电子学', '信号处理', '信息系统'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'chinese-science-bulletin', name: '科学通报', englishName: 'Chinese Science Bulletin',
    cn: '11-1784/N', language: '中文', organizer: '中国科学院、国家自然科学基金委员会',
    fields: ['综合科学', '信息科学', '交叉学科'], keywords: ['science', 'interdisciplinary', '计算科学'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'jcadcg', name: '计算机辅助设计与图形学学报', englishName: 'Journal of Computer-Aided Design & Computer Graphics',
    cn: '11-2925/TP', language: '中文', organizer: '中国计算机学会、北京中科期刊出版有限公司',
    fields: ['计算机图形学', '计算机视觉', '虚拟现实'], keywords: ['computer graphics', 'computer vision', 'visualization', 'CAD'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'chinese-journal-computers', name: '计算机学报', englishName: 'Chinese Journal of Computers',
    cn: '11-1826/TP', language: '中文', organizer: '中国科学院计算技术研究所、中国计算机学会',
    fields: ['计算机科学', '人工智能', '计算机系统'], keywords: ['计算机理论', '软件工程', '数据库', '网络安全'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'crad', name: '计算机研究与发展', englishName: 'Journal of Computer Research and Development',
    cn: '11-1777/TP', language: '中文', organizer: '中国科学院计算技术研究所、中国计算机学会',
    fields: ['计算机科学', '计算机系统', '人工智能'], keywords: ['计算机研究', '软件技术', '数据库', '计算机网络'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'journal-software', name: '软件学报', englishName: 'Journal of Software',
    cn: '11-2560/TP', language: '中文', organizer: '中国科学院软件研究所、中国计算机学会',
    fields: ['软件工程', '系统软件', '程序设计语言'], keywords: ['software engineering', 'system software', 'programming languages', '程序分析'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'journal-communications', name: '通信学报', englishName: 'Journal on Communications',
    cn: '11-2102/TN', language: '中文', organizer: '中国通信学会',
    fields: ['通信技术', '计算机网络', '信息系统'], keywords: ['communications', 'computer networks', 'wireless', '网络通信'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'acta-automatica-sinica', name: '自动化学报', englishName: 'Acta Automatica Sinica',
    cn: '11-2109/TP', language: '中文', organizer: '中国科学院自动化研究所、中国自动化学会',
    fields: ['自动化', '控制科学', '人工智能'], keywords: ['automation', 'control', 'robotics', '模式识别'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'scientia-sinica-informationis', name: '中国科学：信息科学', englishName: 'SCIENTIA SINICA Informationis',
    cn: '11-5846/TP', language: '中文', organizer: '中国科学院、国家自然科学基金委员会',
    fields: ['信息科学', '计算机科学', '通信技术'], keywords: ['信息处理', '计算机系统', '人工智能'],
  }),
  ccfJournal({
    tier: 'CCF-T1', id: 'jcip', name: '中文信息学报', englishName: 'Journal of Chinese Information Processing',
    cn: '11-2325/N', language: '中文', organizer: '中国中文信息学会、中国科学院软件研究所',
    fields: ['自然语言处理', '人工智能', '信息检索'], keywords: ['NLP', '中文信息处理', '机器翻译', '大语言模型'],
  }),

  ccfJournal({
    tier: 'CCF-T2', id: 'china-communications', name: '中国通信（英文）', englishName: 'China Communications',
    cn: '11-5439/TN', language: '英文', organizer: '中国通信学会',
    fields: ['通信技术', '计算机网络', '无线通信'], keywords: ['communications', 'networks', 'wireless'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-computational-mathematics', name: '计算数学（英文）', englishName: 'Journal of Computational Mathematics',
    cn: '11-2126/O1', language: '英文', organizer: '中国科学院数学与系统科学研究院',
    fields: ['计算数学', '数值计算', '科学计算'], keywords: ['computational mathematics', 'numerical analysis', 'scientific computing'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'vrih', name: '虚拟现实与智能硬件（英文）', englishName: 'Virtual Reality & Intelligent Hardware',
    cn: '10-1561/TP', language: '英文', organizer: '中国科技出版传媒股份有限公司、北京航空航天大学',
    fields: ['虚拟现实', '智能硬件', '人机交互'], keywords: ['virtual reality', 'augmented reality', 'intelligent hardware', 'HCI'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'zte-communications-en', name: '中兴通讯技术（英文）', englishName: 'ZTE Communications',
    cn: '34-1294/TN', language: '英文', organizer: '时代出版传媒股份有限公司、深圳航天广宇工业有限公司',
    fields: ['通信技术', '计算机网络', '信息技术'], keywords: ['communications', 'networks', '5G', '6G'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'big-data-research-cn', name: '大数据', englishName: 'Big Data Research',
    cn: '10-1321/G2', language: '中文', organizer: '人民邮电出版社有限公司',
    fields: ['大数据', '数据工程', '数据治理'], keywords: ['big data', 'data engineering', '数据分析'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'computer-education', name: '计算机教育', englishName: 'Computer Education',
    cn: '11-5006/TP', language: '中文', organizer: '清华大学',
    fields: ['计算机教育', '教育技术', '课程建设'], keywords: ['computer education', 'teaching', '教育改革'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'computer-science-cn', name: '计算机科学', englishName: 'Computer Science',
    cn: '50-1075/TP', language: '中文', organizer: '重庆西南信息有限公司',
    fields: ['计算机科学', '人工智能', '软件系统'], keywords: ['计算机技术', '数据科学', '网络安全'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'jofcse', name: '计算机科学与探索', englishName: 'Journal of Frontiers of Computer Science and Technology',
    cn: '11-5602/TP', language: '中文', organizer: '华北计算技术研究所',
    fields: ['计算机科学', '人工智能', '新兴计算'], keywords: ['前沿计算', '机器学习', '计算机系统'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'computer-engineering', name: '计算机工程', englishName: 'Computer Engineering',
    cn: '31-1289/TP', language: '中文', organizer: '华东计算技术研究所、上海市计算机学会',
    fields: ['计算机工程', '软件系统', '网络安全'], keywords: ['工程应用', '人工智能', '计算机网络'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'computer-engineering-science', name: '计算机工程与科学', englishName: 'Computer Engineering & Science',
    cn: '43-1258/TP', language: '中文', organizer: '国防科技大学计算机学院',
    fields: ['计算机工程', '高性能计算', '计算机系统'], keywords: ['computer engineering', 'high performance computing', '体系结构'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'computer-engineering-applications', name: '计算机工程与应用', englishName: 'Computer Engineering and Applications',
    cn: '11-2127/TP', language: '中文', organizer: '华北计算技术研究所',
    fields: ['计算机应用', '人工智能', '软件工程'], keywords: ['工程应用', '机器学习', '系统开发'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'computer-systems-applications', name: '计算机系统应用', englishName: 'Computer Systems & Applications',
    cn: '11-2854/TP', language: '中文', organizer: '中国科学院软件研究所',
    fields: ['计算机系统', '软件工程', '信息系统'], keywords: ['系统应用', '软件开发', '计算机应用'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-computer-applications', name: '计算机应用', englishName: 'Journal of Computer Applications',
    cn: '51-1307/TP', language: '中文', organizer: '四川省计算机学会、中国科学院成都分院',
    fields: ['计算机应用', '人工智能', '数据处理'], keywords: ['computer applications', '机器学习', '信息系统'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-cryptologic-research', name: '密码学报', englishName: 'Journal of Cryptologic Research',
    cn: '10-1195/TN', language: '中文', organizer: '中国密码学会、北京信息科学技术研究院、科学普及出版社',
    fields: ['密码学', '网络安全', '隐私保护'], keywords: ['cryptography', 'information security', '密码协议'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'pr-ai', name: '模式识别与人工智能', englishName: 'Pattern Recognition and Artificial Intelligence',
    cn: '34-1089/TP', language: '中文', organizer: '中国自动化学会、国家智能计算机研究开发中心、中国科学院合肥智能机械研究所',
    fields: ['模式识别', '人工智能', '机器学习'], keywords: ['pattern recognition', 'artificial intelligence', 'computer vision'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-internet-things', name: '物联网学报', englishName: 'Chinese Journal on Internet of Things',
    cn: '10-1491/TP', language: '中文', organizer: '人民邮电出版社有限公司',
    fields: ['物联网', '边缘计算', '智能系统'], keywords: ['internet of things', 'edge computing', 'sensor networks'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'jnis', name: '网络与信息安全学报', englishName: 'Chinese Journal of Network and Information Security',
    cn: '10-1366/TP', language: '中文', organizer: '人民邮电出版社有限公司',
    fields: ['网络安全', '信息安全', '隐私保护'], keywords: ['network security', 'information security', 'privacy'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'mini-micro-systems', name: '小型微型计算机系统', englishName: 'Journal of Chinese Computer Systems',
    cn: '21-1106/TP', language: '中文', organizer: '中国科学院沈阳计算技术研究所',
    fields: ['计算机系统', '计算机网络', '软件工程'], keywords: ['computer systems', 'distributed systems', '计算机应用'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-system-simulation', name: '系统仿真学报', englishName: 'Journal of System Simulation',
    cn: '11-3092/V', language: '中文', organizer: '北京仿真中心、中国仿真学会',
    fields: ['系统仿真', '数字孪生', '智能系统'], keywords: ['simulation', 'digital twin', 'modeling'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-cybersecurity', name: '信息安全学报', englishName: 'Journal of Cyber Security',
    cn: '10-1380/TN', language: '中文', organizer: '中国科学院信息工程研究所、中国科技出版传媒股份有限公司',
    fields: ['信息安全', '网络安全', '密码学'], keywords: ['cyber security', 'information security', '安全协议'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'cjaa-intelligent-systems', name: '智能系统学报', englishName: 'CAAI Transactions on Intelligent Systems',
    cn: '23-1538/TP', language: '中文', organizer: '哈尔滨工程大学、中国人工智能学会',
    fields: ['智能系统', '人工智能', '自动化'], keywords: ['intelligent systems', 'artificial intelligence', '智能控制'],
  }),
  ccfJournal({
    tier: 'CCF-T2', id: 'journal-image-graphics', name: '中国图象图形学报', englishName: 'Journal of Image and Graphics',
    cn: '11-3758/TB', language: '中文', organizer: '中国科学院空天信息创新研究院、中国图象图形学学会、北京应用物理与计算数学研究所',
    fields: ['图像处理', '计算机视觉', '计算机图形学'], keywords: ['image processing', 'computer vision', 'computer graphics'],
  }),
];
