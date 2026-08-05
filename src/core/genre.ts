/**
 * 直播品类预设:不同品类的爆点判据差别极大,把「什么算爆点」做成可选、可改的
 * 配置,而不是写死在提示词里。
 *
 * **分区口径来自平台真实分类,不是拍脑袋列的**:
 *  - B站直播 `api.live.bilibili.com/room/v1/Area/getList`(2026-08 实拉)的
 *    11 个一级分区:网游/手游/单机游戏/娱乐/电台/虚拟主播/聊天室/生活/知识/
 *    赛事/互动玩法/购物;二级分区里有舞见、唱见、颜值、团播、脱口秀、户外、
 *    萌宠、美食、手工绘画、运动体育、自习室、电子榨菜、沉浸体验等
 *  - 抖音直播分区(公开资料):颜值/时尚/亲子/美食/居家/音乐/舞蹈/旅游/萌宠/
 *    教育/科技/汽车/健康/剧情演绎/影视综艺/游戏/体育/健身/科普/财经/三农…
 *  - 斗鱼:游戏/户外/颜值/一起看/科技
 * 按真实分区归并成下面这些预设——所以「虚拟主播」「电台」「萌宠」「美食」
 * 「赛事」「手工」这些不会因为我没想到就漏掉。
 *
 * 更要紧的是各品类**证据权重是反的**:带货/知识的爆点在话里,读文字稿就能挑;
 * 游戏/户外的爆点在语气和观众反应里(怒吼、爆笑、弹幕刷屏),文字稿常常只有
 * 「卧槽」两个字;舞见/萌宠更极端——文字稿基本是空的,全靠画面、音乐和弹幕。
 * 所以每个预设除了判据,还要标明它该信哪路证据(evidence),reaction/visual
 * 两类会额外跑 highlight/moments.ts 的信号通道。
 *
 * 用户可以直接改判据文本(custom),写死的预设只是起点不是终点。纯函数,可单测。
 */

/**
 * 预设 id。按平台一级分区归并而来;仍然枚举不完(平台每月都在加二级分区),
 * 真正兜底的是通用提示词里「先自己判断这是什么内容、再决定信哪路证据」
 * 那一段、说话占比自适应,以及 custom。
 */
export type GenreId =
  | "auto"
  | "shopping"
  | "game"
  | "esports"
  | "vtuber"
  | "show"
  | "looks"
  | "talk"
  | "radio"
  | "knowledge"
  | "outdoor"
  | "food"
  | "pet"
  | "sports"
  | "craft"
  | "cowatch"
  | "interview"
  | "custom";

/**
 * 该品类的爆点主要靠哪一路证据——决定要不要跑信号驱动的候选通道:
 *  - words:话里有内容(带货/知识/访谈),文字稿够用,走原有文本通道
 *  - reaction:靠现场反应(游戏/户外/聊天/电台),峰值时刻的文字常常只有"卧槽"
 *  - visual:靠画面(舞见/唱见/萌宠/美食/手工),文字稿基本是空的
 * reaction/visual 两类必须额外跑 highlight/moments.ts 的信号通道,否则
 * 「没有可引用的原话」= 一条候选都出不来。
 */
export type EvidenceClass = "words" | "reaction" | "visual";

export interface GenrePreset {
  id: GenreId;
  labelZh: string;
  labelEn: string;
  /** 注入 system prompt 的判据段;auto 为空(用通用判据)。 */
  criteriaZh: string;
  criteriaEn: string;
  /** 主证据路径;auto/custom 交给素材自适应(见 moments.shouldRunMoments)。 */
  evidence: EvidenceClass;
}

/** 内置预设。custom 的判据由用户自己填,这里只占位。 */
export const GENRE_PRESETS: GenrePreset[] = [
  {
    id: "auto",
    labelZh: "通用(不指定品类)",
    labelEn: "General",
    criteriaZh: "",
    criteriaEn: "",
    evidence: "words",
  },
  {
    id: "shopping",
    labelZh: "带货 / 购物",
    labelEn: "Live selling / shopping",
    criteriaZh:
      "本场是带货直播(对应 B站「购物」分区、抖音带货)。爆点优先级:①产品出现意外效果/当场翻车(眼见为实,最炸) " +
      "②价格揭晓的那一下(\"原价X今天只要Y\"的落点) ③被追问成分/售后/真假时的回答 " +
      "④真实试用与对比演示 ⑤反常识的选购建议。" +
      "证据权重:以话里的信息为主,语气激动只作参考——带货主播全程亢奋是常态,不代表那里是爆点。" +
      "一律不选:纯憋单拉互动(\"点赞到X万才上链接\",平台判违规会限流)、机械循环的价格话术、等人垫场的闲聊。",
    criteriaEn:
      "Live-selling stream. Priority: (1) a product behaving unexpectedly or a demo going wrong (most explosive), " +
      "(2) the moment the price lands, (3) answers when pressed on ingredients/returns/authenticity, " +
      "(4) genuine try-ons and comparisons, (5) counterintuitive buying advice. " +
      "Evidence weighting: go by what is said; excited tone means little here — these hosts are loud the whole way through. " +
      "Never pick: engagement-baiting stalls, looping price scripts, or idle filler chat.",
    evidence: "words",
  },
  {
    id: "game",
    labelZh: "游戏(网游 / 手游 / 单机)",
    labelEn: "Gaming",
    criteriaZh:
      "本场是游戏直播(B站「网游/手游/单机游戏」三个一级分区都算)。爆点优先级:①极限操作/翻盘/秀技术的瞬间 " +
      "②团灭、被偷家这类惨案与破防 ③和队友或对手的冲突、连麦对线 ④主播的爆笑反应与吐槽金句 ⑤运气离谱的时刻。" +
      "证据权重:**这个品类不要只看文字稿**——精彩瞬间的文字常常只有\"卧槽/我去/没了\"几个字,毫无信息量。" +
      "要重点参考语气激动时段(怒吼/尖叫/爆笑)和弹幕峰值,那才是操作发生的位置;文字稿用来确认那一下发生了什么。" +
      "选段要包含\"操作前的紧张铺垫 + 那一下 + 主播的反应\",只切结果没有过程不好看。",
    criteriaEn:
      "Gaming stream (PC / mobile / console). Priority: (1) clutch plays and comebacks, (2) wipes and disasters, " +
      "(3) friction with teammates or opponents, (4) the host's biggest reactions and one-liners, (5) absurd luck. " +
      "Evidence weighting: **do not go by the transcript alone** — the text at a peak is often just \"holy—\". " +
      "Lean on vocal-emotion peaks and live-chat spikes to locate the play. " +
      "Include the build-up, the moment itself, and the reaction — the payoff alone doesn't play.",
    evidence: "reaction",
  },
  {
    id: "esports",
    labelZh: "赛事解说",
    labelEn: "Esports / match commentary",
    criteriaZh:
      "本场是赛事直播或解说(B站「赛事」分区)。爆点优先级:①决定胜负的那一波团战/进球/绝杀 ②解说情绪炸裂的喊麦 " +
      "③争议判罚与场外插曲 ④选手个人秀操作 ⑤赛后采访的金句。" +
      "证据权重:解说的语气爆发和弹幕峰值几乎就是比分变化的位置,优先信它们;" +
      "文字稿里解说语速极快、专有名词多,转写常出错,别拿错字当内容。" +
      "选段务必包含\"局势铺垫→那一下→解说反应\",只切进球画面没有解说声不成立。",
    criteriaEn:
      "Esports / match broadcast. Priority: (1) the decisive teamfight or goal, (2) the caster losing it, " +
      "(3) controversial calls, (4) individual highlight plays, (5) post-match quotables. " +
      "Evidence weighting: caster vocal peaks and chat spikes track the scoreline — trust them over the transcript, " +
      "which is error-prone at commentary speed. Always include setup → moment → reaction.",
    evidence: "reaction",
  },
  {
    id: "vtuber",
    labelZh: "虚拟主播 / VTuber",
    labelEn: "VTuber",
    criteriaZh:
      "本场是虚拟主播直播(B站「虚拟主播」一级分区:虚拟Singer/Gamer/声优/日常等)。" +
      "**注意:这类内容的表情和肢体来自模型,人脸表情信号基本无效**,别指望它。" +
      "爆点优先级:①中之人破防/笑场/说漏嘴(反差最强) ②角色扮演的名场面与整活 ③歌回的副歌段 " +
      "④与观众/同行的互动名场面 ⑤模型穿帮或技术事故(观众很吃这个)。" +
      "证据权重:语气变化和弹幕峰值是主证据(弹幕在这个品类里极其活跃,几乎等于实时打分);" +
      "画面高能只在歌回/整活时有参考价值。梗要连铺垫一起选。",
    criteriaEn:
      "VTuber stream. **Facial-emotion signals are meaningless here — the face is a rigged model.** " +
      "Priority: (1) the person behind the avatar breaking character or corpsing, (2) memorable bits and roleplay, " +
      "(3) song segments, (4) standout interactions, (5) rigging/technical mishaps (audiences love these). " +
      "Evidence weighting: vocal tone and chat spikes dominate — chat is exceptionally active in this category. " +
      "Always include a joke's setup.",
    evidence: "reaction",
  },
  {
    id: "show",
    labelZh: "才艺 / 舞见 / 唱见 / 团播",
    labelEn: "Performance / dance / singing",
    criteriaZh:
      "本场是才艺表演直播(B站「娱乐」分区下的舞见、视频唱见、团播;抖音的舞蹈/音乐)。" +
      "**注意:这类直播的文字稿基本没有信息量**(多是零散寒暄和口水话)," +
      "不要因为某句话\"读起来还行\"就选它——那不是观众看的东西。" +
      "爆点优先级:①最有记忆点的表演段落(副歌、高难度动作、卡点整齐的那几拍) " +
      "②表演里的高光反应与互动 ③开场或收尾的强画面。" +
      "证据权重:以画面高能时段、音乐节拍与弹幕峰值为主,文字稿只用来避开明显的闲聊段。" +
      "选段要卡在音乐的自然段落上(前奏进、副歌完整、别在半拍处切断),画面完整比话说完更重要。",
    criteriaEn:
      "Performance / dance / singing stream. **The transcript is essentially empty of value here** — " +
      "never pick a moment just because a line reads well. " +
      "Priority: (1) the most memorable passage (the chorus, the hard move, the tightly-hit beats), " +
      "(2) standout reactions during the performance, (3) a strong opening or closing image. " +
      "Evidence weighting: visual-energy windows, musical phrasing and chat spikes. " +
      "Cut on musical phrase boundaries — visual completeness beats finishing a sentence.",
    evidence: "visual",
  },
  {
    id: "looks",
    labelZh: "颜值 / 交友 / 连麦",
    labelEn: "Just chatting / social",
    criteriaZh:
      "本场是颜值或交友连麦直播(B站「聊天室」分区:交友/点唱/找人玩;娱乐分区的颜值)。" +
      "爆点优先级:①连麦对象的意外发言或翻车 ②主播的机智回怼与名场面 ③真情流露或突然认真 " +
      "④整蛊与反差 ⑤高光互动(送礼答谢、才艺穿插)。" +
      "证据权重:语气变化和弹幕峰值为主;这类直播大量时间是无信息量的寒暄和刷屏答谢,**默认从严**——" +
      "宁可一条不出,也不要把\"感谢XX的礼物\"这种切出去。",
    criteriaEn:
      "Just-chatting / social / co-host stream. Priority: (1) a guest saying something unexpected, " +
      "(2) the host's quick comebacks, (3) sudden sincerity, (4) pranks and reversals, (5) standout interactions. " +
      "Evidence weighting: vocal tone and chat spikes. Most of this format is contentless greeting and gift-thanking — " +
      "**be strict by default**; returning nothing beats clipping \"thanks for the gift\".",
    evidence: "reaction",
  },
  {
    id: "talk",
    labelZh: "聊天 / 情感杂谈 / 脱口秀",
    labelEn: "Talk / commentary",
    criteriaZh:
      "本场是聊天杂谈类直播(B站「生活」分区的生活杂谈/情感杂谈、「娱乐」分区的脱口秀)。" +
      "爆点优先级:①争议或出格的发言(前后打脸、双标最炸) ②密集的梗与段子(必须含铺垫) " +
      "③真情流露、突然认真的时刻 ④和观众的名场面互动 ⑤人设反转。" +
      "证据权重:语气和现场反应与话本身同等重要;弹幕峰值是观众实时投票,证据力最强。",
    criteriaEn:
      "Talk / commentary stream. Priority: (1) controversial or off-the-cuff statements (self-contradiction is strongest), " +
      "(2) dense jokes and bits (always with the setup), (3) moments of sudden sincerity, " +
      "(4) memorable audience exchanges, (5) reversals of persona. " +
      "Evidence weighting: tone and room reaction matter as much as the words; chat spikes are the audience voting live.",
    evidence: "reaction",
  },
  {
    id: "radio",
    labelZh: "电台 / 纯语音",
    labelEn: "Radio / audio-only",
    criteriaZh:
      "本场是电台类直播(B站「电台」一级分区:唱见电台/聊天电台/男声电台),**没有画面可用**——" +
      "成片要靠音频波形图或封面,所以画面类证据一律不存在,别去找。" +
      "爆点优先级:①唱段的副歌 ②情绪浓度最高的一段讲述 ③与听众的高光互动 ④金句。" +
      "证据权重:语气变化、笑声/掌声与弹幕峰值是全部证据。" +
      "选段必须听感完整——没有画面兜底,一句话被掐断在这个品类里格外难受。",
    criteriaEn:
      "Radio / audio-only stream. **There is no picture** — output is a waveform or cover art, so visual evidence does not exist. " +
      "Priority: (1) the chorus of a song, (2) the most emotionally dense stretch of talk, (3) standout listener interaction, (4) quotables. " +
      "Evidence weighting: vocal tone, laughter/applause and chat spikes are all you have. " +
      "Clips must be aurally complete — with no picture to carry it, a cut-off sentence is unforgivable here.",
    evidence: "reaction",
  },
  {
    id: "knowledge",
    labelZh: "知识 / 教育 / 科普 / 财经",
    labelEn: "Knowledge / education",
    criteriaZh:
      "本场是知识类直播(B站「知识」一级分区:教育学习/科技科学/社会观察财经/法律心理/历史人文)。" +
      "爆点优先级:①能独立成立的方法论与结论(带步骤、清单、具体数字) ②颠覆常识的判断 " +
      "③一句话说透的金句 ④真实案例与数据 ⑤对典型误区的当场纠正。" +
      "证据权重:几乎全看内容本身,语气信号基本无参考价值。" +
      "**这个品类的目标是「让人想收藏」而不是「让人笑」**——平台现在收藏权重最高。" +
      "所以片段必须信息自足:结论、依据、可执行的做法都要在片段里,不能只有半截。",
    criteriaEn:
      "Knowledge / education stream. Priority: (1) self-contained methods and conclusions (steps, checklists, numbers), " +
      "(2) claims that overturn conventional wisdom, (3) one-line summaries that nail it, (4) real cases and data, " +
      "(5) correcting a common mistake. " +
      "Evidence weighting: judge almost entirely on content; tone signals carry little here. " +
      "**Optimize for saves, not laughs.** The clip must be informationally complete.",
    evidence: "words",
  },
  {
    id: "outdoor",
    labelZh: "户外 / 旅行 / 探店",
    labelEn: "Outdoor / travel / on-location",
    criteriaZh:
      "本场是户外直播(B站「生活」分区的户外;抖音的旅游/三农)。爆点优先级:①突发状况与意外(遇到人、被拦、天气突变、东西坏了) " +
      "②与陌生人的真实互动和对话 ③第一次看到某个场面的即时反应 ④踩雷/避雷的实话 ⑤强画面(风景、场面、猎奇)。" +
      "证据权重:反应类为主——语气和画面变化比文字稿可靠;**户外收音差,转写错字多**,别被错字带偏,读不通的句子优先当噪声。" +
      "选段要带上\"看到之前\"的一点铺垫,观众要跟着主播一起发现才有代入感。",
    criteriaEn:
      "Outdoor / travel / on-location stream. Priority: (1) things going wrong or unexpected encounters, " +
      "(2) genuine interactions with strangers, (3) the instant reaction on first seeing something, " +
      "(4) blunt verdicts on whether a place is worth it, (5) strong imagery. " +
      "Evidence weighting: reaction-driven — tone and visual change beat the transcript; **outdoor audio is poor**, " +
      "so treat garbled lines as noise rather than content. Include a beat of lead-in before the reveal.",
    evidence: "reaction",
  },
  {
    id: "food",
    labelZh: "美食 / 吃播",
    labelEn: "Food / mukbang",
    criteriaZh:
      "本场是美食直播(B站「生活」分区的美食;抖音美食)。**这类内容的说服力在画面和声音上,不在解说词里**。" +
      "爆点优先级:①最有食欲的那一口(拉丝、爆汁、酥脆声) ②备料/翻锅这类有观赏性的动作 " +
      "③吃到意料之外(极辣、极难吃、极好吃)的真实反应 ④食材或价格的意外信息。" +
      "证据权重:画面高能与咀嚼/烹饪的声音峰值为主,弹幕次之;文字稿多是\"嗯好吃\"这类无信息量的话,别当金句。" +
      "选段务必包含完整的一个动作(下锅到出锅、夹起到入口),掐在半途最败胃口。",
    criteriaEn:
      "Food / mukbang stream. **The persuasion is in the picture and the sound, not the narration.** " +
      "Priority: (1) the most appetizing bite (cheese pull, juice, crunch), (2) watchable prep or wok work, " +
      "(3) a genuine reaction to something unexpectedly spicy/awful/great, (4) surprising facts about the ingredient or price. " +
      "Evidence weighting: visual energy and chewing/cooking sound peaks first, chat second; " +
      "the transcript is mostly \"mm, tasty\" — never treat that as a quotable. Always contain one complete action.",
    evidence: "visual",
  },
  {
    id: "pet",
    labelZh: "萌宠",
    labelEn: "Pets",
    criteriaZh:
      "本场是萌宠直播(B站「生活」分区的萌宠;抖音萌宠)。**主角不会说话,文字稿完全不能作为判据**。" +
      "爆点优先级:①动物做出意外或拟人化举动的那一下 ②互动名场面(讨食、拆家、和主人斗智) " +
      "③极致可爱的静态画面(睡姿、奶凶) ④主人被整到的反应。" +
      "证据权重:画面高能与弹幕峰值几乎是唯一证据;主人的语气变化可以帮忙定位\"刚刚发生了什么\"。" +
      "片段要短、要一眼看懂,前 1 秒必须已经能看到动物。",
    criteriaEn:
      "Pet stream. **The subject cannot talk — the transcript is not evidence here at all.** " +
      "Priority: (1) the instant the animal does something unexpected or human-like, (2) memorable interactions, " +
      "(3) peak-cuteness stills, (4) the owner's reaction to being outsmarted. " +
      "Evidence weighting: visual energy and chat spikes are effectively the only evidence; the owner's tone helps locate the beat. " +
      "Keep clips short and instantly legible — the animal must be on screen within the first second.",
    evidence: "visual",
  },
  {
    id: "sports",
    labelZh: "运动 / 健身",
    labelEn: "Sports / fitness",
    criteriaZh:
      "本场是运动健身直播(B站「生活」分区的运动体育;抖音体育/健身)。爆点优先级:①完成高难度动作或破纪录的那一下 " +
      "②失败/受伤/意外(观众同样爱看,但不要消费真实伤情) ③一句话讲清的训练要点 ④体态或成果的前后对比。" +
      "证据权重:画面高能与语气爆发并重,弹幕作旁证;文字稿在动作过程中基本是喘息和计数,没有信息量。" +
      "教学类要点必须信息自足(做什么、练哪里、错在哪),只喊\"再来五个\"不成片。",
    criteriaEn:
      "Sports / fitness stream. Priority: (1) landing a hard move or hitting a PR, (2) a failure or mishap " +
      "(popular, but never exploit a real injury), (3) a coaching point stated in one line, (4) before/after comparisons. " +
      "Evidence weighting: visual energy and vocal bursts together, chat as corroboration; " +
      "the transcript during a set is just breathing and counting. Coaching clips must be self-contained.",
    evidence: "reaction",
  },
  {
    id: "craft",
    labelZh: "手工 / 绘画 / 沉浸体验",
    labelEn: "Crafts / drawing / ambient",
    criteriaZh:
      "本场是手工绘画或沉浸体验类直播(B站「生活」分区的手工绘画、沉浸体验)。" +
      "**这类内容节奏极慢,绝大部分时间不值得剪**,默认从严。" +
      "爆点优先级:①从无到有的关键一步(上色瞬间、成品揭晓) ②失手翻车与补救 ③加速看完整过程的那一段 ④技巧讲解的干货。" +
      "证据权重:画面变化为主(成品揭晓那一下画面差异最大),弹幕次之;讲解声可有可无。" +
      "选\"变化最大\"的时刻,不要选\"一直在涂\"的时刻。",
    criteriaEn:
      "Crafts / drawing / ambient stream. **This format is slow and mostly not clippable** — be strict by default. " +
      "Priority: (1) the key transformation step (first colour, the reveal), (2) a mistake and the save, " +
      "(3) a stretch that works sped up, (4) an actual technique explanation. " +
      "Evidence weighting: visual change first (the reveal is the biggest frame-to-frame delta), chat second. " +
      "Pick the moments of greatest change, not the long stretches of steady work.",
    evidence: "visual",
  },
  {
    id: "cowatch",
    labelZh: "一起看 / 电子榨菜 / 自习室",
    labelEn: "Co-watching / study-with-me",
    criteriaZh:
      "本场是陪伴型直播(B站「生活」分区的电子榨菜、「知识」分区的自习室,斗鱼的一起看)。" +
      "**⚠ 两个硬约束,比选得好不好更重要**:" +
      "①屏幕上播放的影视内容是别人的版权,**绝对不要把影视画面本身切成片发布**——那是搬运,会被判侵权下架;" +
      "②自习室这类内容本身就没有可剪的东西,大部分情况下正确答案是「一条都不给」。" +
      "真要选,只能选**主播自己**的反应和评论(镜头里是主播、声音是主播的那几段),而且要能脱离原片独立成立。" +
      "证据权重:主播的语气爆发与弹幕峰值;画面信号在这里会指向被播放的影视内容,**不能当作选段依据**。",
    criteriaEn:
      "Co-watching / study-with-me stream. **Two hard constraints matter more than picking well:** " +
      "(1) the content on screen is someone else's copyright — **never clip the film/show itself**; that is reuploading and gets taken down; " +
      "(2) study-with-me has nothing to clip; most of the time the correct answer is to return nothing. " +
      "If you do pick, only take the **host's own** reaction and commentary, and only where it stands alone without the source. " +
      "Evidence weighting: host vocal bursts and chat spikes; visual signals here point at the copyrighted content — do not use them.",
    evidence: "reaction",
  },
  {
    id: "interview",
    labelZh: "访谈 / 播客 / 对谈",
    labelEn: "Interview / podcast",
    criteriaZh:
      "本场是访谈/播客对谈。爆点优先级:①尖锐提问与不回避的回答 ②观点交锋、当场不同意 " +
      "③嘉宾说漏嘴或首次披露的信息 ④能独立成立的观点金句 ⑤真情流露的个人经历。" +
      "证据权重:以内容为主。" +
      "**一问一答必须成对**——只有回答没有问题,观众不知道在答什么;跨说话人选段时要含完整的问与答,绝不把两个人的半句拼一起。",
    criteriaEn:
      "Interview / podcast. Priority: (1) a pointed question and an answer that doesn't dodge, (2) genuine disagreement on air, " +
      "(3) something let slip or disclosed for the first time, (4) a standalone quotable take, (5) raw personal story. " +
      "Evidence weighting: content-driven. " +
      "**Keep question and answer together** — never stitch two speakers' half-sentences.",
    evidence: "words",
  },
  {
    id: "custom",
    labelZh: "自定义",
    labelEn: "Custom",
    criteriaZh: "",
    criteriaEn: "",
    evidence: "words",
  },
];

/** 按 id 取预设;未知 id 回落到 auto。纯函数。 */
export function genrePreset(id: string | undefined): GenrePreset {
  return GENRE_PRESETS.find((g) => g.id === id) ?? GENRE_PRESETS[0];
}

/**
 * 旧 id → 新 id。分区表按平台真实分类重排过,已经存在本机的偏好不能因此失效。
 * 命中不了就交给 genrePreset 回落 auto。
 */
const LEGACY_GENRE_IDS: Record<string, GenreId> = {
  "live-sell": "shopping",
  gaming: "game",
  lecture: "knowledge",
};

/** 兼容旧偏好里存的 genreId(v0.9.4 之前的写法)。 */
export function normalizeGenreId(id: string | undefined): string | undefined {
  if (!id) return id;
  return LEGACY_GENRE_IDS[id] ?? id;
}

/**
 * 各品类的跳剪静音阈值(秒):超过该时长的词间空隙才被剪。
 * 2026 调研口径(RESEARCH-2026-08-CLIP-QUALITY.md 第三节):快节奏解说 ~0.3s、
 * 单人口播 0.5-0.7s、双人对谈 0.8-1.2s——对谈的呼吸感被剪光会像机关枪。
 * 未列出的品类走默认 0.6(与历史 GAP_THRESHOLD_SEC 一致,升级不改变成片)。
 */
const GENRE_PAUSE_GAP_SEC: Partial<Record<GenreId, number>> = {
  esports: 0.4, // 解说语速最快,空隙就是拖沓
  game: 0.45,
  sports: 0.5,
  shopping: 0.55, // 带货话术密集,停顿多为憋单
  looks: 0.7, // 连麦一来一回,留一点接话气口
  vtuber: 0.7,
  talk: 0.8, // 杂谈/脱口秀:停顿常是节目效果
  radio: 0.8,
  outdoor: 0.7, // 户外反应滞后,收音又差
  knowledge: 0.7, // 教学停顿是留给观众消化的
  interview: 0.9, // 对谈:问答之间的沉默有信息量
};

/** 跳剪静音阈值的默认档(与 gaps.ts 的历史默认一致)。 */
export const DEFAULT_PAUSE_GAP_SEC = 0.6;

/** 按品类取跳剪静音阈值;未知/未配置回落默认档。纯函数。 */
export function genrePauseGapSec(id: string | undefined): number {
  const norm = normalizeGenreId(id) as GenreId | undefined;
  return (norm && GENRE_PAUSE_GAP_SEC[norm]) || DEFAULT_PAUSE_GAP_SEC;
}

/** 用户自定义判据的长度上限(防止塞爆提示词)。 */
export const GENRE_CUSTOM_MAX_CHARS = 1200;

/**
 * 生成注入 system prompt 的品类段。
 * `customCriteria` 非空时一律优先——用户写的永远盖过内置预设,
 * 这样"选个最接近的预设再改两句"是顺手的用法。返回 "" 表示不注入。纯函数。
 */
export function genreSection(
  id: string | undefined,
  zh: boolean,
  customCriteria?: string
): string {
  const custom = (customCriteria ?? "").trim().slice(0, GENRE_CUSTOM_MAX_CHARS);
  const body = custom || (zh ? genrePreset(normalizeGenreId(id)).criteriaZh : genrePreset(normalizeGenreId(id)).criteriaEn);
  if (!body) return "";
  return zh ? `\n\n【本场类型与判据】${body}` : `\n\n[Stream type & criteria] ${body}`;
}
