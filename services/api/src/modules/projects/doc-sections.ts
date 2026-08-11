import { generateDrawioXml, type DrawioResult } from '../../integrations/drawio/drawio.client';

export type DocTemplateKind = 'egitim' | 'surec' | 'kullanim';
export type FixedDocSectionKey = 'cover' | 'purpose' | 'concepts' | 'flow' | 'situations';
export type StepDocSectionKey = `step-${number}`;
export type DocSectionKey = FixedDocSectionKey | StepDocSectionKey;

export interface DocPlanMeta {
  hedef_kitle?: string | string[];
  moduller?: string[];
  ortam?: string[];
  ornek_kayit?: string;
  surum?: string;
  hazirlayan?: string | string[];
  tur?: DocTemplateKind | string;
  diagram?: boolean;
}

export interface DocPlanScreen {
  title?: string;
  caption?: string;
  platform?: 'fno' | 'bc' | 'web' | string;
  mi?: string;
  cmp?: string;
  page?: string | number;
  company?: string;
  path?: string;
  [key: string]: unknown;
}

export interface DocPlan {
  meta?: DocPlanMeta;
  platform?: string;
  ortam?: string | null;
  modul?: string | null;
  sirket?: string | null;
  yontem?: string[];
  veriseti?: string[];
  ekranlar?: DocPlanScreen[];
  onkosullar?: string[];
  [key: string]: unknown;
}

export interface ObservedField {
  alan: string;
  deger: string;
}

export interface DocSectionDefinition {
  /** Stable metadata/polling key. */
  key: DocSectionKey;
  /** One-based position in the assembled document. */
  index: number;
  label: string;
  modelRequired: boolean;
  screenIndex?: number;
  requiredHeadings: string[];
}

interface DocTemplateDefinition {
  kind: DocTemplateKind;
  focus: string;
  sectionSet: readonly ['cover', 'purpose', 'concepts', 'flow', 'steps', 'situations'];
}

/**
 * All v2 documents retain the CETAŞ delivery skeleton. The selected template
 * changes the writer's emphasis without changing stable section keys, so a
 * saved section can later be regenerated independently.
 */
export const DOC_TEMPLATE_MAP: Readonly<Record<DocTemplateKind, DocTemplateDefinition>> = {
  egitim: {
    kind: 'egitim',
    focus: 'Son kullanıcının işlemi öğrenip aynı sonucu güvenle tekrar edebilmesine odaklan.',
    sectionSet: ['cover', 'purpose', 'concepts', 'flow', 'steps', 'situations'],
  },
  surec: {
    kind: 'surec',
    focus: 'İş akışını, sorumlulukları, girdileri ve çıktıları uçtan uca görünür kılmaya odaklan.',
    sectionSet: ['cover', 'purpose', 'concepts', 'flow', 'steps', 'situations'],
  },
  kullanim: {
    kind: 'kullanim',
    focus: 'Ekrandaki alanları ve kullanıcının uygulayacağı adımları kısa ve eyleme dönük anlatmaya odaklan.',
    sectionSet: ['cover', 'purpose', 'concepts', 'flow', 'steps', 'situations'],
  },
};

export const DIAGRAM_TOKEN = '[[DIAGRAM]]';

const SHOTTER_URL = process.env.SHOTTER_URL ?? 'http://shotter:4600';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const MERMAID_BLOCK_RE = /```mermaid\s*[\r\n]+[\s\S]*?```/gi;
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function cleanLine(value: unknown, fallback = ''): string {
  return String(value ?? fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanList(values: unknown, cap = 12): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanLine(value)).filter(Boolean).slice(0, cap);
}

function screenTitle(screen: DocPlanScreen | undefined, index: number): string {
  return cleanLine(screen?.title || screen?.caption, `Adım ${index}`);
}

function markdownLabel(value: unknown): string {
  return cleanLine(value).replace(/[\[\]]/g, '').replace(/[()]/g, '');
}

function templateFor(value?: unknown): DocTemplateDefinition {
  const kind = cleanLine(value).toLowerCase();
  return DOC_TEMPLATE_MAP[kind === 'surec' || kind === 'kullanim' ? kind : 'egitim'];
}

export function resolveDocTemplateKind(value?: unknown): DocTemplateKind {
  return templateFor(value).kind;
}

export function screenshotToken(screenIndex: number): string {
  return `[[SCREENSHOT:${Math.max(1, Math.trunc(screenIndex))}]]`;
}

export function createDocSectionDefinitions(opts: {
  title: string;
  plan?: DocPlan | null;
  tur?: DocTemplateKind | string;
}): DocSectionDefinition[] {
  const plan = opts.plan ?? {};
  const template = templateFor(opts.tur ?? plan.meta?.tur);
  const title = cleanLine(opts.title, 'Doküman');
  const screens = (Array.isArray(plan.ekranlar) ? plan.ekranlar : []).slice(0, 6);
  const definitions: DocSectionDefinition[] = [];

  // The explicit map is intentionally traversed here instead of hard-coding
  // the returned list: future templates can alter their section set without
  // changing controller orchestration or stored keys.
  for (const section of template.sectionSet) {
    if (section === 'cover') {
      definitions.push({
        key: 'cover', index: definitions.length + 1, label: 'Kapak ve meta', modelRequired: false,
        requiredHeadings: [`# ${title}`],
      });
    } else if (section === 'purpose') {
      definitions.push({
        key: 'purpose', index: definitions.length + 1, label: 'Amaç ve ön koşullar', modelRequired: true,
        requiredHeadings: ['## 1. Amaç ve Kapsam', '## 2. Ön Koşullar'],
      });
    } else if (section === 'concepts') {
      definitions.push({
        key: 'concepts', index: definitions.length + 1, label: 'Temel kavramlar', modelRequired: true,
        requiredHeadings: ['## 3. Temel Kavramlar'],
      });
    } else if (section === 'flow') {
      definitions.push({
        key: 'flow', index: definitions.length + 1, label: 'Süreç akışı', modelRequired: true,
        requiredHeadings: ['## 4. Süreç Akışı'],
      });
    } else if (section === 'steps') {
      screens.forEach((screen, screenOffset) => {
        const screenIndex = screenOffset + 1;
        definitions.push({
          key: `step-${screenIndex}`,
          index: definitions.length + 1,
          label: `Adım ${screenIndex}: ${screenTitle(screen, screenIndex)}`,
          modelRequired: true,
          screenIndex,
          requiredHeadings: [`## Adım ${screenIndex} — ${screenTitle(screen, screenIndex)}`],
        });
      });
    } else if (section === 'situations') {
      definitions.push({
        key: 'situations', index: definitions.length + 1, label: 'Durumlar ve terimler', modelRequired: true,
        requiredHeadings: ['## 5. Sık Karşılaşılan Durumlar', '## 6. Terimler (TR/EN)'],
      });
    }
  }
  return definitions;
}

export function buildCoverSection(opts: {
  title: string;
  plan?: DocPlan | null;
  purpose?: string;
  tur?: DocTemplateKind | string;
}): string {
  const plan = opts.plan ?? {};
  const title = cleanLine(opts.title, 'Doküman');
  const audience = Array.isArray(plan.meta?.hedef_kitle)
    ? cleanList(plan.meta?.hedef_kitle, 4).join(', ')
    : cleanLine(plan.meta?.hedef_kitle, 'Son kullanıcı');
  const suppliedPurpose = cleanLine(opts.purpose);
  const aim = suppliedPurpose ||
    `Bu doküman, ${audience || 'son kullanıcı'} için “${title}” kapsamındaki süreci ve ekran adımlarını açıklar.`;
  return `# ${title}\n\n${aim}`;
}

function markdownContract(): string {
  return (
    'ÇIKTI KURALI: draft.content alanına yalnız istenen başlıklı Markdown bölümünü yaz. ' +
    'İç içe JSON, JSON nesnesi, giriş/sonuç açıklaması veya bölümü saran kod çiti üretme. ' +
    'Tamamen Türkçe yaz; ürün, alan ve menü adları arayüzdeki özgün dilinde kalabilir. ' +
    'Bağlamda bulunmayan kayıt numarası ya da gerçek değer uydurma; örnek değerleri “örn.” ile açıkça işaretle.'
  );
}

export function buildPurposeAndPrerequisitesPrompt(opts: {
  plan?: DocPlan | null;
  tur?: DocTemplateKind | string;
  hasSolutionStack?: boolean;
} = {}): string {
  const plan = opts.plan ?? {};
  const template = templateFor(opts.tur ?? plan.meta?.tur);
  const prerequisites = cleanList(plan.onkosullar, 12);
  const componentInstruction = opts.hasSolutionStack === false
    ? 'Bağlamda çözüm yığını yoksa çözüm bileşenleri alt başlığı veya tablosu ekleme.'
    : 'Bağlamda “ÇÖZÜM YIĞINI” varsa `### 1.1 Çözüm Bileşenleri` alt başlığını ve `| Platform | Bileşen | Yayıncı/Sürüm |` tablosunu ekle; yalnız verilen gerçek bileşenleri kullan. Yoksa bu alt başlığı ekleme.';
  const planPrerequisites = prerequisites.length
    ? `Onaylı planın ön koşulları (bunları doğrulanmış bağlamla somutlaştır):\n${prerequisites.map((item) => `- ${item}`).join('\n')}\n`
    : '';

  return (
    `${markdownContract()}\n${template.focus}\n` +
    'Aşağıdaki başlıkları aynen ve bu sırayla üret:\n' +
    '`## 1. Amaç ve Kapsam` — iş senaryosunu, kapsamı, hedef kullanıcıyı ve beklenen sonucu kısa paragraflarla açıkla.\n' +
    `${componentInstruction}\n` +
    '`## 2. Ön Koşullar` — ardından tam olarak `| Konu | Beklenen durum |` kolonlu bir Markdown tablosu ver. ' +
    'Roller, yetkiler, parametreler, ana veri ve gerekliyse ortam/şirket seçimini gerçek bağlama dayandır.\n' +
    planPrerequisites
  ).trim();
}

export function buildConceptsPrompt(opts: {
  plan?: DocPlan | null;
  tur?: DocTemplateKind | string;
} = {}): string {
  const plan = opts.plan ?? {};
  const template = templateFor(opts.tur ?? plan.meta?.tur);
  return (
    `${markdownContract()}\n${template.focus}\n` +
    'Yalnız `## 3. Temel Kavramlar` başlığını üret. Başlığın altında tam olarak ' +
    '`| Terim | Anlamı |` kolonlu bir Markdown tablosu kullan. ' +
    'Yalnız bu senaryoyu anlamak için gerekli ürün, süreç ve iş terimlerini kısa ve son kullanıcı dilinde açıkla.'
  );
}

function planStepListing(plan: DocPlan): string {
  const screens = (Array.isArray(plan.ekranlar) ? plan.ekranlar : []).slice(0, 6);
  if (!screens.length) return '- Ekran planı yok; bağlamdaki yöntem ve iş adımlarını kullan.';
  return screens.map((screen, index) => {
    const title = screenTitle(screen, index + 1);
    const target = [screen.platform, screen.mi ?? screen.page ?? screen.path]
      .map((value) => cleanLine(value)).filter(Boolean).join(' / ');
    return `- Adım ${index + 1}: ${title}${target ? ` (${target})` : ''}`;
  }).join('\n');
}

export function buildFlowPrompt(opts: {
  plan?: DocPlan | null;
  tur?: DocTemplateKind | string;
  includeDiagramToken?: boolean;
  processSummary?: string;
} = {}): string {
  const plan = opts.plan ?? {};
  const template = templateFor(opts.tur ?? plan.meta?.tur);
  const summary = cleanLine(opts.processSummary) || cleanList(plan.yontem, 8).join(' → ');
  const diagramLine = opts.includeDiagramToken
    ? `Tablodan sonra tek başına tam olarak \`${DIAGRAM_TOKEN}\` satırını koy. `
    : '';
  return (
    `${markdownContract()}\n${template.focus}\n` +
    'Yalnız `## 4. Süreç Akışı` başlığını üret. Kısa süreç özetinden sonra tam olarak ' +
    '`| Adım | Ekran | Yapılan işlem | Çıktı |` kolonlu bir Markdown tablosu ver.\n' +
    `${diagramLine}` +
    'PNG oluşturma başarısızlığına karşı tablodan sonra ayrıca `mermaid` dil etiketli, ilk satırı ' +
    '`flowchart TD` olan tam ve yalnız bir kod çiti üret; başlangıç, işlem/karar ve bitiş düğümlerinin metinleri kısa ve Türkçe olsun. ' +
    'Bu Mermaid bloğu yedektir ve PNG başarıyla üretildiğinde assembler tarafından kaldırılacaktır.\n' +
    (summary ? `Süreç özeti: ${summary}\n` : '') +
    `Planlanan ekranlar:\n${planStepListing(plan)}`
  ).trim();
}

export interface PreparedFlowSection {
  prompt: string;
  diagram: DrawioResult | null;
}

/** Generate the draw.io artifact before asking the writer for the flow text. */
export async function prepareFlowSection(opts: {
  title: string;
  plan?: DocPlan | null;
  tur?: DocTemplateKind | string;
  processSummary?: string;
  timeoutMs?: number;
}): Promise<PreparedFlowSection> {
  const plan = opts.plan ?? {};
  const screens = (Array.isArray(plan.ekranlar) ? plan.ekranlar : []).slice(0, 6);
  const processSummary = cleanLine(opts.processSummary) ||
    cleanList(plan.yontem, 8).join(' → ') || cleanLine(opts.title, 'Süreç akışı');
  let diagram: DrawioResult | null = null;
  if (plan.meta?.diagram !== false) {
    try {
      diagram = await generateDrawioXml({
        prompt: `${cleanLine(opts.title, 'Süreç')} için süreç akışı. ${processSummary}`,
        steps: screens.map((screen, index) => {
          const title = screenTitle(screen, index + 1);
          const caption = cleanLine(screen.caption);
          return { title, caption: caption && caption !== title ? caption : undefined };
        }),
        timeoutMs: opts.timeoutMs,
      });
    } catch {
      // The adapter is already fail-closed; retain the same guarantee if a
      // future implementation unexpectedly throws.
      diagram = null;
    }
  }
  return {
    diagram,
    prompt: buildFlowPrompt({
      plan,
      tur: opts.tur,
      includeDiagramToken: Boolean(diagram?.xml),
      processSummary,
    }),
  };
}

function screenTarget(screen: DocPlanScreen): string {
  const parts = [
    screen.platform && `platform=${cleanLine(screen.platform)}`,
    screen.mi && `mi=${cleanLine(screen.mi)}`,
    screen.cmp && `cmp=${cleanLine(screen.cmp)}`,
    screen.page != null && `page=${cleanLine(screen.page)}`,
    screen.company && `company=${cleanLine(screen.company)}`,
    screen.path && `path=${cleanLine(screen.path)}`,
  ].filter(Boolean);
  return parts.join(', ') || 'hedef ekran bağlamda verilmiştir';
}

export function buildStepPrompt(
  opts: {
    screenIndex: number;
    screen?: DocPlanScreen;
    plan?: DocPlan | null;
    tur?: DocTemplateKind | string;
  },
  observedFields?: ObservedField[],
): string {
  const plan = opts.plan ?? {};
  const template = templateFor(opts.tur ?? plan.meta?.tur);
  const screenIndex = Math.max(1, Math.trunc(opts.screenIndex));
  const screen = opts.screen ?? plan.ekranlar?.[screenIndex - 1] ?? {};
  const title = screenTitle(screen, screenIndex);
  const fields = (Array.isArray(observedFields) ? observedFields : [])
    .map((field) => ({ alan: cleanLine(field?.alan), deger: cleanLine(field?.deger) }))
    .filter((field) => field.alan && field.deger)
    .slice(0, 20);
  const approvedExample = cleanLine(plan.meta?.ornek_kayit);
  const observedBlock = fields.length
    ? 'Görüntüden doğrulanan alan/değer çiftleri (değerleri değiştirmeden ilgili tablo satırlarında kullan):\n' +
      fields.map((field) => `- ${field.alan}: ${field.deger}`).join('\n')
    : approvedExample
      ? `Görüntüden doğrulanmış alan/değer yok. Onaylı örnek kayıt: ${approvedExample}. Bu kaydı yalnız bağlamın desteklediği alanlarda kullan; kalan değerleri “örn. …” diye işaretle.`
      : 'Görüntüden doğrulanmış alan/değer yok. Değer gerekiyorsa yalnız “örn. …” biçiminde açıkça örnek ver; gerçek kayıt numarası uydurma.';

  return (
    `${markdownContract()}\n${template.focus}\n` +
    `Yalnız \`## Adım ${screenIndex} — ${title}\` başlığını üret.\n` +
    '`**Ekranda ne yapılır**` ara başlığının altında kısa ve uygulanabilir numaralı liste kullan. ' +
    'Menü yolu, seçimler ve kaydetme/doğrulama eylemini bağlam izin verdiği ölçüde somutlaştır.\n' +
    '`**Ekranda ne görülür**` ara başlığının altında tam olarak `| Alan | Örnek değer | Açıklama |` kolonlu bir Markdown tablosu kullan.\n' +
    'Tablodan sonra ekran görselinin yerini göstermek üzere tek başına tam olarak ' +
    `\`${screenshotToken(screenIndex)}\` satırını koy; 📷 veya başka görsel yer tutucusu yazma.\n` +
    'Gerçekten yararlıysa en fazla iki callout ekle. Yalnız `:::dikkat`, `:::ipucu` veya `:::uyari` ile aç, içerikten sonra `:::` ile kapat; callout zorunlu değildir.\n' +
    `Hedef ekran: ${title} (${screenTarget(screen)}).\n` +
    observedBlock
  ).trim();
}

export function buildSituationsAndTermsPrompt(opts: {
  plan?: DocPlan | null;
  tur?: DocTemplateKind | string;
} = {}): string {
  const plan = opts.plan ?? {};
  const template = templateFor(opts.tur ?? plan.meta?.tur);
  return (
    `${markdownContract()}\n${template.focus}\n` +
    'Aşağıdaki başlıkları aynen ve bu sırayla üret:\n' +
    '`## 5. Sık Karşılaşılan Durumlar` — tam olarak `| Durum | Olası neden | Yapılacak |` kolonlu bir Markdown tablosu kullan; ' +
    'yalnız senaryoyla ilgili, gerçekçi ve eyleme dönük durumlar yaz.\n' +
    '`## 6. Terimler (TR/EN)` — tam olarak `| Türkçe | İngilizce |` kolonlu bir Markdown tablosu kullan; ' +
    'dokümanda geçen ürün ve süreç terimlerinin kısa karşılıklarını ver.'
  );
}

export function buildSectionPrompt(
  definition: DocSectionDefinition,
  opts: {
    title: string;
    plan?: DocPlan | null;
    tur?: DocTemplateKind | string;
    hasSolutionStack?: boolean;
    includeDiagramToken?: boolean;
    processSummary?: string;
  },
  observedFields?: ObservedField[],
): string | null {
  if (definition.key === 'cover') return null;
  if (definition.key === 'purpose') {
    return buildPurposeAndPrerequisitesPrompt({
      plan: opts.plan, tur: opts.tur, hasSolutionStack: opts.hasSolutionStack,
    });
  }
  if (definition.key === 'concepts') return buildConceptsPrompt({ plan: opts.plan, tur: opts.tur });
  if (definition.key === 'flow') {
    return buildFlowPrompt({
      plan: opts.plan,
      tur: opts.tur,
      includeDiagramToken: opts.includeDiagramToken,
      processSummary: opts.processSummary,
    });
  }
  if (definition.key === 'situations') return buildSituationsAndTermsPrompt({ plan: opts.plan, tur: opts.tur });
  const screenIndex = definition.screenIndex ?? Number(definition.key.replace('step-', ''));
  return buildStepPrompt({
    screenIndex,
    screen: opts.plan?.ekranlar?.[screenIndex - 1],
    plan: opts.plan,
    tur: opts.tur,
  }, observedFields);
}

export function buildSectionWarningStub(
  section?: Pick<DocSectionDefinition, 'requiredHeadings'> | string,
): string {
  const warning = '> [!UYARI] Bu bölüm üretilemedi';
  if (!section) return warning;
  if (typeof section === 'string') {
    const heading = section.trim();
    return heading ? `${heading}\n\n${warning}` : warning;
  }
  if (!section.requiredHeadings.length) return warning;
  return section.requiredHeadings.map((heading) => `${heading}\n\n${warning}`).join('\n\n');
}

export interface GeneratedDocSection {
  key: DocSectionKey;
  markdown: string;
  /** createDocSectionDefinitions().index; inferred from key when omitted. */
  index?: number;
  /** One-based index for step sections. */
  screenIndex?: number;
  status?: 'done' | 'warn';
  model?: string | null;
}

export interface DocScreenshot {
  caption: string;
  dataUri?: string;
  /** Optional one-based association; exact caption matching is otherwise used. */
  screenIndex?: number;
  /** Optional text/markdown used when capture was unavailable. */
  placeholder?: string;
}

export interface AssembleDocSectionsOptions {
  sections: GeneratedDocSection[];
  plan?: DocPlan | null;
  diagram?: DrawioResult | null;
  screenshots?: DocScreenshot[];
  shotterUrl?: string;
  drawioTimeoutMs?: number;
}

export interface AssembledDocSections {
  markdown: string;
  drawioXml: string | null;
  drawioSource: DrawioResult['source'] | null;
  diagramRendered: boolean;
  screenshotsEmbedded: number;
}

function inferredSectionOrder(section: GeneratedDocSection, position: number): number {
  if (Number.isFinite(section.index)) return Number(section.index);
  if (section.key === 'cover') return 10;
  if (section.key === 'purpose') return 20;
  if (section.key === 'concepts') return 30;
  if (section.key === 'flow') return 40;
  if (section.key.startsWith('step-')) {
    const step = Number(section.key.slice(5));
    return 100 + (Number.isFinite(step) ? step : position);
  }
  if (section.key === 'situations') return 1000;
  return 2000 + position;
}

function mermaidFallback(screens: DocPlanScreen[]): string {
  const labels = screens.slice(0, 6).map((screen, index) => {
    const value = screenTitle(screen, index + 1)
      .replace(/["\\]/g, '')
      .replace(/[\[\]{}()]/g, '')
      .slice(0, 80);
    return value || `Adım ${index + 1}`;
  });
  const nodes = [
    '  start(["Başlangıç"])',
    ...labels.map((label, index) => `  step${index + 1}["${label}"]`),
    '  finish(["Tamamlandı"])',
  ];
  const ids = ['start', ...labels.map((_label, index) => `step${index + 1}`), 'finish'];
  const edges = ids.slice(0, -1).map((id, index) => `  ${id} --> ${ids[index + 1]}`);
  return `\`\`\`mermaid\nflowchart TD\n${[...nodes, ...edges].join('\n')}\n\`\`\``;
}

async function renderDrawioPng(xml: string, shotterUrl: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${shotterUrl.replace(/\/+$/, '')}/render-drawio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({ xml }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const result: any = await response.json();
    const png = cleanLine(result?.png);
    return result?.ok && png && /^[A-Za-z0-9+/=]+$/.test(png) ? png : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCaption(value: unknown): string {
  return cleanLine(value).toLocaleLowerCase('tr-TR');
}

function screenshotFor(
  screenIndex: number,
  screen: DocPlanScreen | undefined,
  screenshots: DocScreenshot[],
  screenCount: number,
): DocScreenshot | undefined {
  const explicit = screenshots.find((shot) => shot.screenIndex === screenIndex);
  if (explicit) return explicit;
  const caption = normalizeCaption(screen?.caption || screen?.title);
  if (caption) {
    const matching = screenshots.find((shot) => normalizeCaption(shot.caption) === caption);
    if (matching) return matching;
  }
  // Positional association is safe only when every requested screen produced
  // a result; captureEnvironmentShots otherwise returns a compacted array.
  return screenshots.length === screenCount ? screenshots[screenIndex - 1] : undefined;
}

/**
 * Join persisted section outputs, replace screenshot tokens, and prefer the
 * rendered draw.io image only after shotter confirms it. Until that point the
 * model-produced Mermaid block stays in the markdown as a lossless fallback.
 */
export async function assembleDocSections(opts: AssembleDocSectionsOptions): Promise<AssembledDocSections> {
  const plan = opts.plan ?? {};
  const screens = (Array.isArray(plan.ekranlar) ? plan.ekranlar : []).slice(0, 6);
  const screenshots = Array.isArray(opts.screenshots) ? opts.screenshots : [];
  const ordered = opts.sections
    .map((section, position) => ({ section, position }))
    .sort((a, b) => inferredSectionOrder(a.section, a.position) - inferredSectionOrder(b.section, b.position));

  let diagramRendered = false;
  let screenshotsEmbedded = 0;
  const assembled: string[] = [];

  for (const { section } of ordered) {
    let markdown = String(section.markdown ?? '').trim();
    if (!markdown) continue;

    if (section.key === 'flow') {
      // A malformed/short model response should not leave the document with no
      // process visual at all. Normally this is the model-authored block.
      if (!/```mermaid\s*[\r\n]/i.test(markdown)) {
        markdown = `${markdown}\n\n${mermaidFallback(screens)}`;
      }

      let png: string | null = null;
      if (opts.diagram?.xml) {
        png = await renderDrawioPng(
          opts.diagram.xml,
          opts.shotterUrl ?? SHOTTER_URL,
          Number.isFinite(opts.drawioTimeoutMs) ? Math.max(1, Number(opts.drawioTimeoutMs)) : 45_000,
        );
      }

      if (png) {
        const image = `![Süreç akışı](data:image/png;base64,${png})`;
        markdown = markdown.includes(DIAGRAM_TOKEN)
          ? markdown.split(DIAGRAM_TOKEN).join(image)
          : `${markdown}\n\n${image}`;
        // Rendering succeeded: the PNG is now authoritative, so suppress the
        // fallback instead of showing two copies of the same process.
        markdown = markdown.replace(MERMAID_BLOCK_RE, '').trim();
        diagramRendered = true;
      } else {
        // Rendering failed or no draw.io artifact exists. Do not leak an
        // internal token into the customer document; retain Mermaid instead.
        markdown = markdown.split(DIAGRAM_TOKEN).join('').trim();
      }
    }

    if (section.key.startsWith('step-')) {
      const parsedIndex = Number(section.key.slice(5));
      const screenIndex = section.screenIndex ?? (Number.isFinite(parsedIndex) ? parsedIndex : 1);
      const screen = screens[screenIndex - 1];
      const screenshot = screenshotFor(screenIndex, screen, screenshots, screens.length);
      const token = screenshotToken(screenIndex);
      let replacement = '';
      if (screenshot?.dataUri && DATA_IMAGE_RE.test(screenshot.dataUri)) {
        const caption = markdownLabel(screen?.caption || screen?.title || screenshot.caption || `Ekran ${screenIndex}`);
        replacement = `![Ekran ${screenIndex} — ${caption}](${screenshot.dataUri})`;
        screenshotsEmbedded += 1;
      } else if (screenshot?.placeholder) {
        replacement = String(screenshot.placeholder).trim();
      }

      if (markdown.includes(token)) {
        markdown = markdown.split(token).join(replacement).trim();
      } else if (replacement && !/data:image\//i.test(markdown)) {
        // Models occasionally omit an exact token; keep the real capture in
        // the correct step rather than dropping it from the document.
        markdown = `${markdown}\n\n${replacement}`;
      }
    }

    assembled.push(markdown);
  }

  // Unknown/mistyped screenshot tokens should never reach the renderer.
  const markdown = assembled.join('\n\n').replace(/\[\[SCREENSHOT:\d+\]\]/g, '').trim();
  return {
    markdown,
    drawioXml: opts.diagram?.xml ?? null,
    drawioSource: opts.diagram?.source ?? null,
    diagramRendered,
    screenshotsEmbedded,
  };
}
