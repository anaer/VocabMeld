/**
 * VocabMeld 内容脚本
 * 注入到网页中，处理词汇替换和用户交互
 */

// 由于 content script 不支持 ES modules，我们需要将所有代码整合

(async function() {
  'use strict';

  // ============ 配置常量 ============
  const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const INTENSITY_CONFIG = {
    low: { maxPerParagraph: 4 },
    medium: { maxPerParagraph: 8 },
    high: { maxPerParagraph: 14 }
  };
  const SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CODE', 'PRE', 'KBD', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON'];
  const SKIP_CLASSES = ['vocabmeld-translated', 'vocabmeld-tooltip', 'hljs', 'code', 'syntax'];
  const CACHE_MAX_SIZE = 2000;

  // ============ 状态管理 ============
  let config = null;
  let isProcessing = false;
  let processedFingerprints = new Set();
  let wordCache = new Map();
  let tooltip = null;
  let selectionPopup = null;

  // ============ 工具函数 ============
  function isDifficultyCompatible(wordDifficulty, userDifficulty) {
    const wordIdx = CEFR_LEVELS.indexOf(wordDifficulty);
    const userIdx = CEFR_LEVELS.indexOf(userDifficulty);
    return wordIdx >= userIdx;
  }

  function generateFingerprint(text, path = '') {
    const content = text.slice(0, 100).trim();
    let hash = 0;
    const str = content + path;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  function debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function detectLanguage(text) {
    const chineseRegex = /[\u4e00-\u9fff]/g;
    const japaneseRegex = /[\u3040-\u309f\u30a0-\u30ff]/g;
    const koreanRegex = /[\uac00-\ud7af]/g;
    const latinRegex = /[a-zA-Z]/g;

    const chineseCount = (text.match(chineseRegex) || []).length;
    const japaneseCount = (text.match(japaneseRegex) || []).length;
    const koreanCount = (text.match(koreanRegex) || []).length;
    const latinCount = (text.match(latinRegex) || []).length;
    const total = chineseCount + japaneseCount + koreanCount + latinCount || 1;

    if (japaneseCount / total > 0.1) return 'ja';
    if (koreanCount / total > 0.1) return 'ko';
    if (chineseCount / total > 0.3) return 'zh-CN';
    return 'en';
  }

  function isCodeText(text) {
    const codePatterns = [
      /^(const|let|var|function|class|import|export|return|if|else|for|while)\s/,
      /[{}();]\s*$/,
      /^\s*(\/\/|\/\*|\*|#)/,
      /\w+\.\w+\(/,
      /console\./,
      /https?:\/\//
    ];
    return codePatterns.some(pattern => pattern.test(text.trim()));
  }

  // 重建文本，只保留指定的词汇（用于发送给 AI）
  function reconstructTextWithWords(text, targetWords) {
    const targetWordSet = new Set(targetWords.map(w => w.toLowerCase()));
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

    const relevantSentences = sentences.filter(sentence => {
      const words = sentence.match(/\b[a-zA-Z]{3,}\b/g) || [];
      const chineseWords = sentence.match(/[\u4e00-\u9fff]{2,4}/g) || [];
      const allWords = [...words, ...chineseWords];
      return allWords.some(word => targetWordSet.has(word.toLowerCase()));
    });

    return relevantSentences.join('. ').trim() + (relevantSentences.length > 0 ? '.' : '');
  }

  // ============ 存储操作 ============
  async function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (result) => {
        config = {
          apiEndpoint: result.apiEndpoint || 'https://api.deepseek.com/chat/completions',
          apiKey: result.apiKey || '',
          modelName: result.modelName || 'deepseek-chat',
          nativeLanguage: result.nativeLanguage || 'zh-CN',
          targetLanguage: result.targetLanguage || 'en',
          difficultyLevel: result.difficultyLevel || 'B1',
          intensity: result.intensity || 'medium',
          autoProcess: result.autoProcess ?? false,
          showPhonetic: result.showPhonetic ?? true,
          translationStyle: result.translationStyle || 'translation-original',
          enabled: result.enabled ?? true,
          blacklist: result.blacklist || [],
          whitelist: result.whitelist || [],
          learnedWords: result.learnedWords || [],
          memorizeList: result.memorizeList || []
        };
        resolve(config);
      });
    });
  }

  async function loadWordCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get('vocabmeld_word_cache', (result) => {
        const cached = result.vocabmeld_word_cache;
        if (cached && Array.isArray(cached)) {
          cached.forEach(item => {
            wordCache.set(item.key, {
              translation: item.translation,
              phonetic: item.phonetic,
              difficulty: item.difficulty
            });
          });
        }
        resolve(wordCache);
      });
    });
  }

  async function saveWordCache() {
    const data = [];
    for (const [key, value] of wordCache) {
      data.push({ key, ...value });
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ vocabmeld_word_cache: data }, resolve);
    });
  }

  async function updateStats(stats) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['totalWords', 'todayWords', 'lastResetDate', 'cacheHits', 'cacheMisses'], (current) => {
        const today = new Date().toISOString().split('T')[0];
        if (current.lastResetDate !== today) {
          current.todayWords = 0;
          current.lastResetDate = today;
        }
        const updated = {
          totalWords: (current.totalWords || 0) + (stats.newWords || 0),
          todayWords: (current.todayWords || 0) + (stats.newWords || 0),
          lastResetDate: today,
          cacheHits: (current.cacheHits || 0) + (stats.cacheHits || 0),
          cacheMisses: (current.cacheMisses || 0) + (stats.cacheMisses || 0)
        };
        chrome.storage.sync.set(updated, () => resolve(updated));
      });
    });
  }

  async function addToWhitelist(original, translation, difficulty) {
    const whitelist = config.learnedWords || [];
    const exists = whitelist.some(w => w.original === original || w.word === translation);
    if (!exists) {
      whitelist.push({ 
        original, 
        word: translation, 
        addedAt: Date.now(),
        difficulty: difficulty || 'B1'
      });
      config.learnedWords = whitelist;
      await new Promise(resolve => chrome.storage.sync.set({ learnedWords: whitelist }, resolve));
    }
  }

  async function addToMemorizeList(word) {
    if (!word || !word.trim()) {
      console.warn('[VocabMeld] Invalid word for memorize list:', word);
      return;
    }

    const trimmedWord = word.trim();
    const list = config.memorizeList || [];
    const exists = list.some(w => w.word === trimmedWord);
    
    if (!exists) {
      list.push({ word: trimmedWord, addedAt: Date.now() });
      config.memorizeList = list;
      await new Promise(resolve => chrome.storage.sync.set({ memorizeList: list }, resolve));

      // 添加到记忆列表后，立即检查页面上是否存在这些单词并触发翻译
      console.log('[VocabMeld] Added to memorize list:', trimmedWord);
      
      // 确保配置已加载且扩展已启用
      if (!config) {
        await loadConfig();
      }
      
      // 确保扩展已启用
      if (!config.enabled) {
        console.log('[VocabMeld] Extension disabled, skipping translation');
        showToast(`"${trimmedWord}" 已添加到记忆列表`);
        return;
      }
      
      // 立即触发翻译处理（等待完成以确保翻译结果正确应用到页面）
      try {
        console.log('[VocabMeld] Starting processSpecificWords for:', trimmedWord);
        const count = await processSpecificWords([trimmedWord]);
        console.log('[VocabMeld] Processed', count, 'words for:', trimmedWord);
        
        if (count > 0) {
          showToast(`"${trimmedWord}" 已添加到记忆列表并翻译`);
        } else {
          // 即使页面上没有找到，也要确保翻译结果被缓存，以便下次加载时使用
          console.log('[VocabMeld] Word not found on page, ensuring translation is cached');
          try {
            const translations = await translateSpecificWords([trimmedWord]);
            // 翻译已缓存，但不显示toast
            if (translations.length > 0) {
              console.log('[VocabMeld] Translation cached for:', trimmedWord);
            }
            showToast(`"${trimmedWord}" 已添加到记忆列表`);
          } catch (error) {
            console.error('[VocabMeld] Error translating word:', trimmedWord, error);
            showToast(`"${trimmedWord}" 已添加到记忆列表`);
          }
        }
      } catch (error) {
        console.error('[VocabMeld] Error processing word:', trimmedWord, error);
        showToast(`"${trimmedWord}" 已添加到记忆列表`);
      }
    } else {
      console.log('[VocabMeld] Word already in memorize list:', trimmedWord);
      showToast(`"${trimmedWord}" 已在记忆列表中`);
    }
  }

  // ============ DOM 处理 ============
  function shouldSkipNode(node) {
    if (!node) return true;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) return true;
    if (node.nodeType === Node.TEXT_NODE) return shouldSkipNode(node.parentElement);

    const element = node;
    if (SKIP_TAGS.includes(element.tagName)) return true;
    const classList = element.className?.toString() || '';
    if (SKIP_CLASSES.some(cls => classList.includes(cls))) return true;

    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch (e) {}

    if (element.isContentEditable) return true;
    if (element.hasAttribute('data-vocabmeld-processed')) return true;

    return false;
  }

  function getElementPath(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body) {
      let selector = current.tagName?.toLowerCase() || '';
      if (current.id) selector += `#${current.id}`;
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join('>');
  }

  function findTextContainers(root) {
    const containers = [];
    const blockTags = ['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'BLOCKQUOTE'];
    
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        if (blockTags.includes(node.tagName)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });

    let node;
    while (node = walker.nextNode()) {
      const hasDirectText = Array.from(node.childNodes).some(
        child => child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 10
      );
      if (hasDirectText) containers.push(node);
    }
    return containers;
  }

  function getTextContent(element) {
    const texts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (shouldSkipNode(node.parentElement)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent.trim();
        if (text.length > 0 && !isCodeText(text)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    while (node = walker.nextNode()) texts.push(node.textContent);
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function getPageSegments(viewportOnly = false, margin = 300) {
    const segments = [];
    let viewportTop = 0, viewportBottom = Infinity;
    
    if (viewportOnly) {
      viewportTop = window.scrollY - margin;
      viewportBottom = window.scrollY + window.innerHeight + margin;
    }

    const containers = findTextContainers(document.body);

    for (const container of containers) {
      if (viewportOnly) {
        const rect = container.getBoundingClientRect();
        const elementTop = rect.top + window.scrollY;
        const elementBottom = rect.bottom + window.scrollY;
        if (elementBottom < viewportTop || elementTop > viewportBottom) continue;
      }

      const text = getTextContent(container);
      if (!text || text.length < 50) continue;
      if (isCodeText(text)) continue;

      const path = getElementPath(container);
      const fingerprint = generateFingerprint(text, path);
      if (processedFingerprints.has(fingerprint)) continue;

      segments.push({ element: container, text: text.slice(0, 2000), fingerprint, path });
    }

    return segments;
  }

  // ============ 文本替换 ============
  function createReplacementElement(original, translation, phonetic, difficulty) {
    const wrapper = document.createElement('span');
    wrapper.className = 'vocabmeld-translated';
    wrapper.setAttribute('data-original', original);
    wrapper.setAttribute('data-translation', translation);
    wrapper.setAttribute('data-phonetic', phonetic || '');
    wrapper.setAttribute('data-difficulty', difficulty || 'B1');
    
    // 根据配置的样式生成不同的HTML
    const style = config.translationStyle || 'translation-original';
    let innerHTML = '';
    
    switch (style) {
      case 'translation-only':
        // 只显示译文
        innerHTML = `<span class="vocabmeld-word">${translation}</span>`;
        break;
      case 'original-translation':
        // 原文(译文)
        innerHTML = `<span class="vocabmeld-original">${original}</span><span class="vocabmeld-word">(${translation})</span>`;
        break;
      case 'translation-original':
      default:
        // 译文(原文) - 默认样式
        innerHTML = `<span class="vocabmeld-word">${translation}</span><span class="vocabmeld-original">(${original})</span>`;
        break;
    }
    
    wrapper.innerHTML = innerHTML;
    return wrapper;
  }

  function applyReplacements(element, replacements) {
    if (!element || !replacements?.length) return 0;

    let count = 0;
    // 使用过滤器，跳过已翻译的元素和不应该处理的节点
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        // 跳过已翻译的元素
        if (parent.classList?.contains('vocabmeld-translated')) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // 跳过不应该处理的节点类型
        if (SKIP_TAGS.includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        
        // 跳过代码相关的类
        const classList = parent.className?.toString() || '';
        if (SKIP_CLASSES.some(cls => classList.includes(cls) && cls !== 'vocabmeld-translated')) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // 跳过隐藏元素
        try {
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        } catch (e) {}
        
        // 跳过可编辑元素
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        
        const text = node.textContent.trim();
        if (text.length === 0) return NodeFilter.FILTER_REJECT;
        
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    // 按位置从后往前排序，避免位置偏移问题
    const sortedReplacements = [...replacements].sort((a, b) => (b.position || 0) - (a.position || 0));

    for (const replacement of sortedReplacements) {
      const { original, translation, phonetic, difficulty } = replacement;
      const lowerOriginal = original.toLowerCase();
      
      for (let i = 0; i < textNodes.length; i++) {
        const textNode = textNodes[i];
        const text = textNode.textContent;
        const lowerText = text.toLowerCase();
        
        // 检查文本节点是否包含目标单词
        if (!lowerText.includes(lowerOriginal)) continue;
        
        // 使用单词边界匹配，确保匹配完整单词
        const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 匹配单词边界（包括中文标点）
        const regex = new RegExp(`(^|[^\\w\\u4e00-\\u9fff])${escapedOriginal}([^\\w\\u4e00-\\u9fff]|$)`, 'i');
        
        let match = regex.exec(text);
        let startIndex = match ? match.index + match[1].length : text.toLowerCase().indexOf(lowerOriginal);
        
        if (startIndex === -1) continue;

        try {
          const range = document.createRange();
          range.setStart(textNode, startIndex);
          range.setEnd(textNode, startIndex + original.length);
          
          const rangeContent = range.toString();
          if (rangeContent.toLowerCase() !== lowerOriginal) continue;

          // 检查是否已经被替换（检查父元素是否是已翻译的元素）
          let parent = textNode.parentElement;
          let isAlreadyReplaced = false;
          while (parent && parent !== element) {
            if (parent.classList?.contains('vocabmeld-translated')) {
              isAlreadyReplaced = true;
              break;
            }
            parent = parent.parentElement;
          }
          
          if (isAlreadyReplaced) continue;

          const wrapper = createReplacementElement(original, translation, phonetic, difficulty);
          range.deleteContents();
          range.insertNode(wrapper);
          count++;
          
          // 移除已处理的文本节点（因为DOM结构已改变）
          textNodes.splice(i, 1);
          i--; // 调整索引
          break;
        } catch (e) {
          console.error('[VocabMeld] Replacement error:', e, original);
        }
      }
    }

    if (count > 0) element.setAttribute('data-vocabmeld-processed', 'true');
    return count;
  }

  function restoreOriginal(element) {
    if (!element.classList?.contains('vocabmeld-translated')) return;
    const original = element.getAttribute('data-original');
    const textNode = document.createTextNode(original);
    element.parentNode.replaceChild(textNode, element);
  }

  function restoreAll() {
    document.querySelectorAll('.vocabmeld-translated').forEach(restoreOriginal);
    document.querySelectorAll('[data-vocabmeld-processed]').forEach(el => el.removeAttribute('data-vocabmeld-processed'));
    processedFingerprints.clear();
  }

  // ============ API 调用 ============
  async function translateText(text) {
    if (!config.apiKey || !config.apiEndpoint) {
      throw new Error('API 未配置');
    }

    // 确保缓存已加载
    if (wordCache.size === 0) {
      await loadWordCache();
    }

    const sourceLang = detectLanguage(text);
    const targetLang = sourceLang === config.nativeLanguage ? config.targetLanguage : config.nativeLanguage;
    const maxReplacements = INTENSITY_CONFIG[config.intensity]?.maxPerParagraph || 8;

    // 检查缓存 - 只检查有意义的词汇（排除常见停用词）
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their']);
    
    const words = (text.match(/\b[a-zA-Z]{3,}\b/g) || []).filter(w => !stopWords.has(w.toLowerCase()));
    const chineseWords = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
    const allWords = [...new Set([...words, ...chineseWords])];

    const cached = [];
    const uncached = [];

    for (const word of allWords) {
      const key = `${word.toLowerCase()}:${sourceLang}:${targetLang}`;
      if (wordCache.has(key)) {
        cached.push({ word, ...wordCache.get(key) });
      } else {
        uncached.push(word);
      }
    }

    // 过滤缓存结果（按难度）
    const filteredCached = cached
      .filter(c => isDifficultyCompatible(c.difficulty || 'B1', config.difficultyLevel))
      .map(c => {
        const idx = text.toLowerCase().indexOf(c.word.toLowerCase());
        return { 
          original: c.word, 
          translation: c.translation, 
          phonetic: c.phonetic, 
          difficulty: c.difficulty, 
          position: idx >= 0 ? idx : 0, 
          fromCache: true 
        };
      });

    // 立即返回缓存结果（立即显示）
    const immediateResults = filteredCached.slice(0, maxReplacements);
    
    // 更新统计
    if (immediateResults.length > 0) {
      updateStats({ cacheHits: immediateResults.length, cacheMisses: 0 });
    }

    // 如果没有未缓存的词汇，直接返回缓存结果
    if (uncached.length === 0) {
      return { immediate: immediateResults, async: null };
    }

    // 构建只包含未缓存词汇的文本用于发送给 AI
    const filteredText = reconstructTextWithWords(text, uncached);

    // 判断是否需要限制异步替换数量
    const cacheSatisfied = immediateResults.length >= maxReplacements;
    const textTooShort = filteredText.trim().length < 50;
    
    // 如果文本太短，不需要调用API
    if (textTooShort) {
      return { immediate: immediateResults, async: null };
    }

    // 计算还需要翻译的词汇数量
    const remainingSlots = maxReplacements - immediateResults.length;
    
    // 如果缓存已满足配置，异步替换最多1个词；否则按剩余槽位计算
    const maxAsyncReplacements = cacheSatisfied ? 1 : remainingSlots;
    
    // 如果不需要异步替换，直接返回
    if (maxAsyncReplacements <= 0) {
      return { immediate: immediateResults, async: null };
    }
    
    // 动态计算AI应该返回的词汇数量（通常是配置值的1.5-2倍，让AI有选择空间）
    // 但如果缓存已满足或文本极少，限制AI返回数量
    const aiTargetCount = cacheSatisfied 
      ? 1 
      : Math.max(maxAsyncReplacements, Math.ceil(maxReplacements * 1.5));

    // 异步调用 API，处理未缓存的词汇（不阻塞立即返回）
    const asyncPromise = (async () => {
      try {
        const prompt = `你是一个语言学习助手。请分析以下文本，选择适合学习的词汇进行翻译。

## 规则：
1. 选择约 ${aiTargetCount} 个左右有学习价值的词汇（实际返回数量可以根据文本内容灵活调整，但不要超过 ${maxReplacements * 2} 个）
2. 避免替换：专有名词、人名、地名、品牌名、数字、代码、URL、已经是目标语言的词
3. 优先选择：常用词汇、有学习价值的词汇、不同难度级别的词汇
4. 翻译方向：从 ${sourceLang} 翻译到 ${targetLang}
5. 翻译倾向：结合上下文，夹杂起来也能容易被理解，尽量只翻译成最合适的词汇，而不是多个含义。

## CEFR等级从简单到复杂依次为：A1-C2

## 输出格式：
返回 JSON 数组，每个元素包含：
- original: 原词
- translation: 翻译结果
- phonetic: 学习语言(${config.targetLanguage})的音标/发音
- difficulty: CEFR 难度等级 (A1/A2/B1/B2/C1/C2)，请谨慎评估
- position: 在文本中的起始位置

## 文本：
${filteredText}

## 输出：
只返回 JSON 数组，不要其他内容。`;

        const response = await fetch(config.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.modelName,
            messages: [
              { role: 'system', content: '你是一个专业的语言学习助手。始终返回有效的 JSON 格式。' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2000
          })
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error?.message || `API Error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        
        let allResults = [];
        try {
          allResults = JSON.parse(content);
          if (!Array.isArray(allResults)) {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) allResults = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) allResults = JSON.parse(jsonMatch[0]);
        }

        // 先缓存所有词汇（包括所有难度级别），供不同难度设置的用户使用
        for (const item of allResults) {
          const key = `${item.original.toLowerCase()}:${sourceLang}:${targetLang}`;
          // 如果已存在，先删除（LRU）
          if (wordCache.has(key)) {
            wordCache.delete(key);
          }
          
          // 如果达到上限，删除最早的项
          while (wordCache.size >= CACHE_MAX_SIZE) {
            const firstKey = wordCache.keys().next().value;
            wordCache.delete(firstKey);
          }
          
          // 添加新项
          wordCache.set(key, {
            translation: item.translation,
            phonetic: item.phonetic || '',
            difficulty: item.difficulty || 'B1'
          });
        }
        saveWordCache();

        // 本地过滤：只保留符合用户难度设置的词汇
        const filteredResults = allResults.filter(item => isDifficultyCompatible(item.difficulty || 'B1', config.difficultyLevel));

        // 更新统计
        updateStats({ newWords: filteredResults.length, cacheHits: cached.length, cacheMisses: 1 });

        // 修正 AI 返回结果的位置（从过滤文本映射回原始文本）
        const correctedResults = filteredResults.map(result => {
          const originalIndex = text.toLowerCase().indexOf(result.original.toLowerCase());
          return {
            ...result,
            position: originalIndex >= 0 ? originalIndex : result.position
          };
        });

        // 合并缓存结果（去重，避免与已显示的缓存结果重复）
        const immediateWords = new Set(immediateResults.map(r => r.original.toLowerCase()));
        const cachedResults = cached
          .filter(c => 
            !immediateWords.has(c.word.toLowerCase()) && 
            !correctedResults.some(r => r.original.toLowerCase() === c.word.toLowerCase()) &&
            isDifficultyCompatible(c.difficulty || 'B1', config.difficultyLevel)
          )
          .map(c => {
            const idx = text.toLowerCase().indexOf(c.word.toLowerCase());
            return { original: c.word, translation: c.translation, phonetic: c.phonetic, difficulty: c.difficulty, position: idx, fromCache: true };
          });

        // 合并结果：补充的缓存结果 + API结果
        // 限制异步替换数量（如果缓存已满足配置或文本极少，最多只替换1个词）
        const mergedResults = [...cachedResults, ...correctedResults];
        return mergedResults.slice(0, maxAsyncReplacements);

      } catch (error) {
        console.error('[VocabMeld] Async API Error:', error);
        // API失败时返回空数组，不影响已显示的缓存结果
        return [];
      }
    })();

    return { immediate: immediateResults, async: asyncPromise };
  }

  // ============ 特定单词处理 ============
  async function translateSpecificWords(targetWords) {
    console.log('[VocabMeld] translateSpecificWords called with:', targetWords);

    if (!config.apiKey || !config.apiEndpoint || !targetWords?.length) {
      console.log('[VocabMeld] translateSpecificWords skipped - missing config or target words');
      return [];
    }

    const sourceLang = detectLanguage(targetWords.join(' '));
    const targetLang = sourceLang === config.nativeLanguage ? config.targetLanguage : config.nativeLanguage;

    console.log('[VocabMeld] Detected languages - source:', sourceLang, 'target:', targetLang);

    const uncached = [];
    const cached = [];

    // 检查缓存（复用统一流程）
    for (const word of targetWords) {
      const key = `${word.toLowerCase()}:${sourceLang}:${targetLang}`;
      if (wordCache.has(key)) {
        // LRU: 访问时移到末尾（通过删除再添加实现）
        const cachedItem = wordCache.get(key);
        wordCache.delete(key);
        wordCache.set(key, cachedItem);
        cached.push({ word, ...cachedItem });
      } else {
        uncached.push(word);
      }
    }

    console.log('[VocabMeld] Cache status - cached:', cached.length, 'uncached:', uncached.length);

    let allResults = cached.map(c => ({
      original: c.word,
      translation: c.translation,
      phonetic: c.phonetic,
      difficulty: c.difficulty
    }));

    // 如果有未缓存的单词，调用API
    if (uncached.length > 0) {
      try {
        const prompt = `你是一个语言学习助手。请翻译以下特定词汇。

## 规则：
1. 必须翻译所有提供的词汇，不要跳过任何词
2. 如果单词是${sourceLang}，则翻译到${targetLang}，反之亦然

## CEFR等级从简单到复杂依次为：A1-C2

## 输出格式：
返回 JSON 数组，每个元素包含：
- original: 原词
- translation: 翻译结果
- phonetic: 学习语言(${config.targetLanguage})的音标/发音
- difficulty: CEFR 难度等级 (A1/A2/B1/B2/C1/C2)

## 要翻译的词汇：
${uncached.join(', ')}

## 输出：
只返回 JSON 数组，不要其他内容。`;

        const response = await fetch(config.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.modelName,
            messages: [
              { role: 'system', content: '你是一个专业的语言学习助手。始终返回有效的 JSON 格式。' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 1000
          })
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error?.message || `API Error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';

        let apiResults = [];
        try {
          apiResults = JSON.parse(content);
          if (!Array.isArray(apiResults)) {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) apiResults = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) apiResults = JSON.parse(jsonMatch[0]);
        }

        // 缓存结果（复用统一流程，实现LRU淘汰）
        for (const item of apiResults) {
          const key = `${item.original.toLowerCase()}:${sourceLang}:${targetLang}`;
          // 如果已存在，先删除（LRU）
          if (wordCache.has(key)) {
            wordCache.delete(key);
          }
          
          // 如果达到上限，删除最早的项
          while (wordCache.size >= CACHE_MAX_SIZE) {
            const firstKey = wordCache.keys().next().value;
            wordCache.delete(firstKey);
          }
          
          // 添加新项
          wordCache.set(key, {
            translation: item.translation,
            phonetic: item.phonetic || '',
            difficulty: item.difficulty || 'B1'
          });
        }
        saveWordCache();

        allResults = [...allResults, ...apiResults];

        // 更新统计
        updateStats({ newWords: apiResults.length, cacheHits: cached.length, cacheMisses: 1 });

      } catch (error) {
        console.error('[VocabMeld] API Error for specific words:', error);
        // 如果API失败，至少返回缓存的结果
      }
    }

    return allResults.filter(item => targetWords.some(w => w.toLowerCase() === item.original.toLowerCase()));
  }

  async function processSpecificWords(targetWords) {
    if (!config?.enabled || !targetWords?.length) {
      console.log('[VocabMeld] processSpecificWords skipped - config disabled or no target words');
      return 0;
    }

    console.log('[VocabMeld] processSpecificWords called with:', targetWords);

    const targetWordSet = new Set(targetWords.map(w => w.toLowerCase()));
    let processed = 0;

    // 首先检查已翻译的元素，看是否有目标单词已经被翻译了
    const alreadyTranslated = [];
    document.querySelectorAll('.vocabmeld-translated').forEach(el => {
      const original = el.getAttribute('data-original');
      if (original && targetWordSet.has(original.toLowerCase())) {
        alreadyTranslated.push(original.toLowerCase());
      }
    });

    // 查找页面中包含目标单词的文本节点（包括已处理过的容器）
    const textNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // 跳过不应该处理的节点类型
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        // 跳过脚本、样式等标签
        if (SKIP_TAGS.includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        
        // 跳过代码相关的类
        const classList = parent.className?.toString() || '';
        if (SKIP_CLASSES.some(cls => classList.includes(cls) && cls !== 'vocabmeld-translated')) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // 跳过隐藏元素
        try {
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        } catch (e) {}
        
        // 跳过可编辑元素
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        
        const text = node.textContent.trim();
        if (text.length === 0) return NodeFilter.FILTER_REJECT;
        
        // 跳过代码文本
        if (isCodeText(text)) return NodeFilter.FILTER_REJECT;
        
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent;
      // 检查文本节点是否包含目标单词（作为完整单词）
      const words = text.match(/\b[a-zA-Z]{3,}\b/g) || [];
      const chineseWords = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
      const allWords = [...words, ...chineseWords];

      // 检查是否包含目标单词（且该单词还没有被翻译）
      const containsTarget = allWords.some(word => {
        const lowerWord = word.toLowerCase();
        return targetWordSet.has(lowerWord) && !alreadyTranslated.includes(lowerWord);
      });

      if (containsTarget) {
        textNodes.push(node);
      }
    }

    console.log('[VocabMeld] Found', textNodes.length, 'text nodes containing target words');

    // 如果没有找到未翻译的文本节点，说明单词可能已经被翻译了
    if (textNodes.length === 0) {
      console.log('[VocabMeld] No untranslated text nodes found. Words may already be translated.');
      return 0;
    }

    // 构造包含目标单词的文本段落用于处理
    const segments = [];
    for (const textNode of textNodes) {
      // 获取更大的上下文（父元素的文本内容）
      const container = textNode.parentElement;
      if (!container) continue;
      
      // 获取容器的完整文本内容（包括已翻译的部分）
      const containerText = getTextContent(container);
      
      // 如果容器文本太短，尝试获取更大的上下文
      let contextText = containerText;
      if (contextText.length < 30) {
        const grandParent = container.parentElement;
        if (grandParent) {
          contextText = getTextContent(grandParent);
        }
      }

      if (contextText.length >= 10) {
        const path = getElementPath(container);
        const fingerprint = generateFingerprint(contextText, path);
        
        // 检查是否已经处理过这个段落
        const isProcessed = container.hasAttribute('data-vocabmeld-processed') || 
                           container.closest('[data-vocabmeld-processed]');
        
        segments.push({
          element: container,
          text: contextText,
          fingerprint: fingerprint,
          isProcessed: !!isProcessed
        });
      }
    }

    // 去重
    const uniqueSegments = segments.filter((segment, index, self) =>
      index === self.findIndex(s => s.fingerprint === segment.fingerprint)
    );

    console.log('[VocabMeld] Found', uniqueSegments.length, 'unique segments to process');

    // 获取目标单词的翻译
    console.log('[VocabMeld] Translating specific words:', targetWords);
    const translations = await translateSpecificWords(targetWords);
    console.log('[VocabMeld] Got translations:', translations);

    if (translations.length === 0) {
      console.log('[VocabMeld] No translations received');
      return 0;
    }

    // 应用到每个段落
    for (const segment of uniqueSegments) {
      // 为每个翻译添加位置信息（基于当前段落的文本）
      const replacements = translations.map(translation => {
        const position = segment.text.toLowerCase().indexOf(translation.original.toLowerCase());
        return {
          original: translation.original,
          translation: translation.translation,
          phonetic: translation.phonetic,
          difficulty: translation.difficulty,
          position: position >= 0 ? position : 0
        };
      }).filter(r => r.position >= 0 || segment.text.toLowerCase().includes(r.original.toLowerCase()));

      if (replacements.length === 0) continue;

      console.log('[VocabMeld] Applying replacements to segment:', segment.element.textContent.substring(0, 100));
      const count = applyReplacements(segment.element, replacements);
      console.log('[VocabMeld] Applied', count, 'replacements to segment');
      processed += count;
    }

    console.log('[VocabMeld] Total processed words:', processed);
    return processed;
  }

  // ============ 页面处理 ============
  const MAX_CONCURRENT = 3; // 最大并发请求数

  async function processPage(viewportOnly = false) {
    if (isProcessing) return { processed: 0, skipped: true };
    if (!config?.enabled) return { processed: 0, disabled: true };

    // 检查黑名单
    const hostname = window.location.hostname;
    if (config.blacklist?.some(domain => hostname.includes(domain))) {
      return { processed: 0, blacklisted: true };
    }

    // 确保缓存已加载
    if (wordCache.size === 0) {
      await loadWordCache();
    }

    isProcessing = true;
    let processed = 0, errors = 0;

    try {
      // 首先处理记忆列表中的单词（优先处理）
      const memorizeWords = (config.memorizeList || []).map(w => w.word).filter(w => w && w.trim());
      if (memorizeWords.length > 0 && !viewportOnly) {
        console.log(`[VocabMeld] Processing ${memorizeWords.length} words from memorize list`);
        try {
          const memorizeCount = await processSpecificWords(memorizeWords);
          processed += memorizeCount;
          console.log(`[VocabMeld] Processed ${memorizeCount} words from memorize list`);
        } catch (e) {
          console.error('[VocabMeld] Error processing memorize list:', e);
          errors++;
        }
      }

      const segments = getPageSegments(viewportOnly);
      console.log(`[VocabMeld] Found ${segments.length} segments to process`);

      const whitelistWords = new Set((config.learnedWords || []).map(w => w.original.toLowerCase()));

      // 预处理：过滤有效的 segments
      const validSegments = [];
      for (const segment of segments) {
        let text = segment.text;
        for (const word of whitelistWords) {
          const regex = new RegExp(`\\b${word}\\b`, 'gi');
          text = text.replace(regex, '');
        }
        if (text.trim().length >= 30) {
          validSegments.push({ ...segment, filteredText: text });
        }
      }

      // 并行处理单个 segment（支持异步更新）
      async function processSegment(segment) {
        try {
          const result = await translateText(segment.filteredText);
          
          // 先应用缓存结果（立即显示）
          let immediateCount = 0;
          if (result.immediate?.length) {
            const filtered = result.immediate.filter(r => !whitelistWords.has(r.original.toLowerCase()));
            immediateCount = applyReplacements(segment.element, filtered);
            processedFingerprints.add(segment.fingerprint);
          }
          
          // 如果有异步结果，等待并更新（不阻塞）
          if (result.async) {
            result.async.then(async (asyncReplacements) => {
              if (asyncReplacements?.length) {
                // 获取已替换的词汇，避免重复替换
                const alreadyReplaced = new Set();
                segment.element.querySelectorAll('.vocabmeld-translated').forEach(el => {
                  const original = el.getAttribute('data-original');
                  if (original) {
                    alreadyReplaced.add(original.toLowerCase());
                  }
                });
                
                // 过滤掉已替换的词汇
                const filtered = asyncReplacements.filter(r => 
                  !whitelistWords.has(r.original.toLowerCase()) &&
                  !alreadyReplaced.has(r.original.toLowerCase())
                );
                
                if (filtered.length > 0) {
                  const asyncCount = applyReplacements(segment.element, filtered);
                  console.log(`[VocabMeld] Async updated ${asyncCount} words for segment`);
                }
              }
            }).catch(error => {
              console.error('[VocabMeld] Async translation error:', error);
            });
          }
          
          return { count: immediateCount, error: false };
        } catch (e) {
          console.error('[VocabMeld] Segment error:', e);
          return { count: 0, error: true };
        }
      }

      // 分批并行处理（控制并发数）
      for (let i = 0; i < validSegments.length; i += MAX_CONCURRENT) {
        const batch = validSegments.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(batch.map(processSegment));
        
        for (const result of results) {
          processed += result.count;
          if (result.error) errors++;
        }
      }

      console.log(`[VocabMeld] Processed ${processed} words`);
      return { processed, errors };
    } finally {
      isProcessing = false;
    }
  }

  // ============ UI 组件 ============
  function createTooltip() {
    if (tooltip) return;
    
    tooltip = document.createElement('div');
    tooltip.className = 'vocabmeld-tooltip';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);
  }

  function showTooltip(element) {
    if (!tooltip || !element.classList?.contains('vocabmeld-translated')) return;

    const original = element.getAttribute('data-original');
    const translation = element.getAttribute('data-translation');
    const phonetic = element.getAttribute('data-phonetic');
    const difficulty = element.getAttribute('data-difficulty');

    tooltip.innerHTML = `
      <div class="vocabmeld-tooltip-header">
        <span class="vocabmeld-tooltip-word">${translation}</span>
        <span class="vocabmeld-tooltip-badge">${difficulty}</span>
      </div>
      ${phonetic && config.showPhonetic ? `<div class="vocabmeld-tooltip-phonetic">${phonetic}</div>` : ''}
      <div class="vocabmeld-tooltip-original">原文: ${original}</div>
      <div class="vocabmeld-tooltip-tip">左键点击发音 · 右键标记已学会</div>
    `;

    const rect = element.getBoundingClientRect();
    tooltip.style.left = rect.left + window.scrollX + 'px';
    tooltip.style.top = rect.bottom + window.scrollY + 5 + 'px';
    tooltip.style.display = 'block';
  }

  function hideTooltip() {
    if (tooltip) tooltip.style.display = 'none';
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'vocabmeld-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('vocabmeld-toast-show'), 10);
    setTimeout(() => {
      toast.classList.remove('vocabmeld-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function createSelectionPopup() {
    if (selectionPopup) return;
    
    selectionPopup = document.createElement('div');
    selectionPopup.className = 'vocabmeld-selection-popup';
    selectionPopup.style.display = 'none';
    selectionPopup.innerHTML = '<button class="vocabmeld-add-memorize">添加到需记忆</button>';
    document.body.appendChild(selectionPopup);

    selectionPopup.querySelector('button').addEventListener('click', async () => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      if (text && text.length < 50) {
        await addToMemorizeList(text);
        showToast(`"${text}" 已添加到需记忆列表`);
      }
      selectionPopup.style.display = 'none';
    });
  }

  // ============ 事件处理 ============
  function setupEventListeners() {
    // 悬停显示提示 - 使用 mouseenter/mouseleave 更稳定
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      if (target) {
        showTooltip(target);
      }
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      const relatedTarget = e.relatedTarget;
      
      // 只有当鼠标移出到非翻译元素和非tooltip时才隐藏
      if (target && 
          !relatedTarget?.closest('.vocabmeld-translated') && 
          !relatedTarget?.closest('.vocabmeld-tooltip')) {
        hideTooltip();
      }
    });
    
    // 鼠标移出 tooltip 时也隐藏
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest('.vocabmeld-tooltip') && 
          !e.relatedTarget?.closest('.vocabmeld-tooltip') &&
          !e.relatedTarget?.closest('.vocabmeld-translated')) {
        hideTooltip();
      }
    });

    // 左键点击发音
    document.addEventListener('click', (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      if (target) {
        const word = target.getAttribute('data-translation');
        const lang = config.targetLanguage === 'en' ? 'en-US' : 
                     config.targetLanguage === 'zh-CN' ? 'zh-CN' :
                     config.targetLanguage === 'ja' ? 'ja-JP' :
                     config.targetLanguage === 'ko' ? 'ko-KR' : 'en-US';
        
        chrome.runtime.sendMessage({ action: 'speak', text: word, lang });
      }
    });

    // 右键标记已学会
    document.addEventListener('contextmenu', async (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      if (target) {
        e.preventDefault();
        const original = target.getAttribute('data-original');
        const translation = target.getAttribute('data-translation');
        const difficulty = target.getAttribute('data-difficulty') || 'B1';
        await addToWhitelist(original, translation, difficulty);
        restoreOriginal(target);
        hideTooltip(); // 隐藏tooltip
        showToast(`"${original}" 已标记为已学会`);
      }
    });

    // 选择文本显示添加按钮
    document.addEventListener('mouseup', (e) => {
      if (e.target.closest('.vocabmeld-selection-popup')) return;
      
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        
        if (text && text.length > 1 && text.length < 50 && !e.target.closest('.vocabmeld-translated')) {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          
          selectionPopup.style.left = rect.left + window.scrollX + 'px';
          selectionPopup.style.top = rect.bottom + window.scrollY + 5 + 'px';
          selectionPopup.style.display = 'block';
        } else {
          selectionPopup.style.display = 'none';
        }
      }, 10);
    });

    // 滚动处理（懒加载）
    const handleScroll = debounce(() => {
      if (config?.autoProcess && config?.enabled) {
        processPage(true);
      }
    }, 500);
    window.addEventListener('scroll', handleScroll, { passive: true });

    // 监听配置变化
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        loadConfig().then(() => {
          if (changes.enabled?.newValue === false) {
            restoreAll();
          }
          // 难度、强度或样式变化时，需要重新处理页面
          if (changes.difficultyLevel || changes.intensity || changes.translationStyle) {
            restoreAll(); // 先恢复页面（会清除 processedFingerprints）
            if (config.enabled) {
              processPage(); // 重新处理
            }
          }
          // 记忆列表变化时，处理新添加的单词
          if (changes.memorizeList) {
            const oldList = changes.memorizeList.oldValue || [];
            const newList = changes.memorizeList.newValue || [];
            // 找出新添加的单词
            const oldWords = new Set(oldList.map(w => w.word.toLowerCase()));
            const newWords = newList
              .filter(w => !oldWords.has(w.word.toLowerCase()))
              .map(w => w.word);
            
            if (newWords.length > 0 && config.enabled) {
              console.log('[VocabMeld] New words added to memorize list:', newWords);
              // 延迟处理，确保DOM已更新
              setTimeout(() => {
                processSpecificWords(newWords).then(count => {
                  console.log('[VocabMeld] Processed', count, 'new words from memorize list');
                });
              }, 200);
            }
          }
        });
      }
    });

    // 监听来自 popup 或 background 的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'processPage') {
        processPage().then(sendResponse);
        return true;
      }
      if (message.action === 'restorePage') {
        restoreAll();
        sendResponse({ success: true });
      }
      if (message.action === 'processSpecificWords') {
        const words = message.words || [];
        if (words.length > 0) {
          processSpecificWords(words).then(count => {
            sendResponse({ success: true, count });
          }).catch(error => {
            console.error('[VocabMeld] Error processing specific words:', error);
            sendResponse({ success: false, error: error.message });
          });
          return true; // 保持消息通道开放以支持异步响应
        } else {
          sendResponse({ success: false, error: 'No words provided' });
        }
      }
      if (message.action === 'getStatus') {
        sendResponse({
          processed: processedFingerprints.size,
          isProcessing,
          enabled: config?.enabled
        });
      }
    });
  }

  // ============ 初始化 ============
  async function init() {
    console.log('[VocabMeld] Initializing...');

    await loadConfig();
    await loadWordCache();

    
    createTooltip();
    createSelectionPopup();
    
    setupEventListeners();
    
    // 自动处理 - 只有在 API 配置好且开启自动处理时才执行
    if (config.autoProcess && config.enabled && config.apiKey) {
      console.log('[VocabMeld] Auto-processing enabled, starting...');
      setTimeout(() => processPage(), 1000);
    } else {
      console.log('[VocabMeld] Auto-processing disabled or API not configured');
    }
    
    console.log('[VocabMeld] Initialized successfully, config:', {
      autoProcess: config.autoProcess,
      enabled: config.enabled,
      hasApiKey: !!config.apiKey,
      difficultyLevel: config.difficultyLevel
    });
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
