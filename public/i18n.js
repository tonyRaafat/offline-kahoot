// i18n.js — hand-rolled English/Arabic localization (no framework, no build
// step). Loaded as a plain script BEFORE each page's module scripts so the
// global API exists for them.
//
// Usage:
//   - Static HTML: data-i18n="key" (textContent) or
//     data-i18n-attr="placeholder:key;aria-label:key" (attribute hooks).
//   - JS-generated text: t('key', {params}) / I18n.set(el, key, params) /
//     I18n.clear(el). Strings set through I18n.set are remembered and
//     re-translated automatically when the language changes.
//   - Toggle: a segmented EN/AR control is injected on every page by
//     buildToggle(); issue 03 may re-style or re-place it.
//
// Language is per-device only: auto-detected from the browser on first visit
// (any 'ar*' navigator.languages entry -> Arabic), persisted in localStorage,
// and never sent to the server.

(function () {
  'use strict';

  const LANG_KEY = 'offline-kahoot:lang';

  const STRINGS = {
    en: {
      // Shared
      'app.title.host': 'Offline Kahoot — Host',
      'app.title.dashboard': 'Offline Kahoot — Quizzes',
      'app.title.player': 'Offline Kahoot — Join',
      'app.title.login': 'Offline Kahoot — Log in',
      'app.title.editor': 'Offline Kahoot — Editor',
      'word.question': 'Question',
      'word.points': '{points} pts',
      'common.quizCount': '{title} ({count} questions)',

      // Host page
      'host.join': 'Join the game',
      'host.joinUrl': 'Join URL',
      'host.pin': 'PIN',
      'host.scan': 'Scan to join',
      'host.qrAlt': 'QR code with the join URL',
      'host.players': 'Players',
      'host.lobbyEmpty': 'Waiting for players to join — share the PIN or the QR code.',
      'host.quiz': 'Quiz',
      'host.chooseQuiz': 'Choose a quiz…',
      'host.exportQuiz': 'Export "{title}"',
      'host.startGame': 'Start game',
      'host.timeLeft': 'Time left',
      'host.reveal': 'Reveal answer',
      'host.nextQuestion': 'Next question',
      'host.correctAnswer': 'Correct answer',
      'host.answeredCorrectly': 'Answered correctly',
      'host.next': 'Next',
      'host.option': 'Option {number}',
      'host.leaderboard': 'Leaderboard',
      'host.podium': '🏆 Podium',
      'host.backToLobby': 'Back to dashboard',
      'host.dashboard': '‹ Dashboard',
      'host.failedSession': 'host page failed to load session: {detail}',

      // Dashboard page (admin-dashboard issue 04)
      'dashboard.title': 'Quizzes',
      'dashboard.live': 'Game live — join with PIN {pin}',
      'dashboard.openHostLabel': 'Open the live-game host screen',
      'dashboard.logout': 'Log out',
      'dashboard.logoutFailed': 'Could not log out: {detail}',
      'dashboard.create': 'Create',
      'dashboard.start': 'Start',
      'dashboard.import': 'Import',
      'dashboard.imported': 'Imported quiz: {title}',
      'dashboard.importedMany': 'Imported {count} quizzes.',
      'dashboard.importFailed': 'Import failed: {detail}',
      'dashboard.importNotJson': 'Import failed: the file is not valid JSON.',
      'dashboard.questionCount': '{count} questions',
      'dashboard.edit': 'Edit',
      'dashboard.delete': 'Delete',
      'dashboard.starting': 'Loading "{title}" — heading to the host screen…',
      'dashboard.empty': 'No quizzes yet — create your first quiz.',
      'dashboard.created': 'Created quiz: {title}',
      'dashboard.failedList': 'Failed to list quizzes: {detail}',
      'dashboard.failedCreate': 'Create failed: {detail}',
      'dashboard.failedStart': 'Failed to start: {detail}',
      'dashboard.failedDelete': 'Delete failed: {detail}',

      // Login page
      'login.title': 'Log in',
      'login.password': 'Admin password',
      'login.submit': 'Log in',
      'login.submitting': 'Logging in…',
      'login.err.wrongPassword': 'Wrong password — try again',
      'login.err.network': 'Could not reach the server. Are you on the host Wi-Fi?',

      // Player page
      'player.joinTitle': 'Join the game',
      'player.pinLabel': 'Game PIN',
      'player.pinPlaceholder': '000000',
      'player.nameLabel': 'Nickname',
      'player.namePlaceholder': 'Nickname',
      'player.colorLabel': 'Avatar color',
      'player.color.red': 'red',
      'player.color.orange': 'orange',
      'player.color.blue': 'blue',
      'player.color.green': 'green',
      'player.color.pink': 'pink',
      'player.color.white': 'white',
      'player.color.yellow': 'yellow',
      'player.color.brown': 'brown',
      'player.color.black': 'black',
      'player.color.grey': 'grey',
      'player.join': 'Join',
      'player.leave': 'Leave',
      'player.inTitle': "You're in!",
      'player.playingAs': 'Playing as',
      'player.waiting': 'Waiting for the host to start…',
      'player.players': 'Players',
      'player.leaderboard': 'Leaderboard',
      'player.nextComing': 'Next question coming up…',
      'player.gameOver': '🏆 Game over!',
      'player.reconnecting': 'Reconnecting…',
      'player.joining': 'Joining…',
      'player.inProgress': 'Game in progress…',
      'player.enterPin': 'Enter the 6-digit game PIN',
      'player.nameLength': 'Nickname must be 1–20 characters',
      'player.noServer': 'Cannot reach the game server. Are you on the same Wi-Fi as the host?',
      'player.timeout': 'Connection timed out — is the host laptop on and on the same Wi-Fi?',
      'player.lostConnection': 'Lost connection to the game server.',
      'player.answerLocked': 'Answer locked in!',
      'player.correct': 'Correct!',
      'player.incorrect': 'Incorrect',
      'player.correctAnswer': 'Correct answer: {answer}',
      'player.rank': "You're #{rank} of {total}",
      'player.rankWaiting': 'Waiting for standings…',
      'player.err.bad-pin': 'Wrong game PIN — check the host screen',
      'player.err.bad-name': 'Nickname must be 1–20 characters',
      'player.err.nameTaken': 'That nickname is taken — pick another one',
      'player.err.colorRejected': 'Pick an avatar color, then join again',
      'player.err.game-started': 'The game already started — joining closed',
      'player.err.default': 'Could not join — check the PIN and try again',
      'player.rej.late': 'Too late — answers for this question are closed',
      'player.rej.already-answered': 'Already answered for this question',
      'player.rej.unknown-player': 'Cannot submit — connection lost your seat',
      'player.rej.invalid-answer': 'That answer was not valid',
      'player.rej.default': 'Answer rejected',

      // Editor page
      'editor.title': 'Quiz editor',
      'editor.quizzes': 'Quizzes',
      'editor.noQuizzes': 'No quizzes yet — create one below.',
      'editor.newQuiz': 'New quiz',
      'editor.titlePlaceholder': 'Quiz title',
      'editor.create': 'Create quiz',
      'editor.back': '‹ Back to dashboard',
      'editor.editing': 'Editing quiz',
      'editor.rename': 'Rename',
      'editor.deleteQuiz': 'Delete quiz',
      'editor.backShort': '‹ Back',
      'editor.questions': 'Questions',
      'editor.addQuestion': '＋ Add question',
      'editor.save': '💾 Save quiz',
      'editor.question': 'Question {number}',
      'editor.removeQuestion': 'Remove this question',
      'editor.prompt': 'Prompt',
      'editor.type': 'Type',
      'editor.typeMultiple': 'multiple-choice',
      'editor.typeTrueFalse': 'true-false',
      'editor.timer': 'Timer (seconds)',
      'editor.correctAnswer': 'Correct answer',
      'editor.optionsCorrect': 'Options (first row = correct via radio)',
      'editor.addOption': '＋ Add option',
      'editor.option': 'Option {number}',
      'editor.removeOption': 'Remove this option',
      'editor.saved': 'Saved. The host page picks this up on its next reload.',
      'editor.renamed': 'Renamed to "{title}"',
      'editor.deleteConfirm': 'Delete quiz "{title}"? This cannot be undone.',
      'editor.deleted': 'Deleted quiz "{title}"',
      'editor.giveTitle': 'Give the new quiz a title first.',
      'editor.createFailed': 'Create failed: {detail}',
      'editor.failedList': 'Failed to list quizzes: {detail}',
      'editor.failedLoad': 'Failed to load quiz: {detail}',
      'editor.err.title': 'title: must be a non-empty string',
      'editor.err.prompt': 'Question {number}: prompt must be non-empty',
      'editor.err.timer': 'Question {number}: timer must be a positive number of seconds',
      'editor.err.options': 'Question {number}: needs 2–4 non-empty options',
      'editor.err.correct': 'Question {number}: needs a selected correct answer',
    },

    ar: {
      // Shared
      'app.title.host': 'Offline Kahoot — المضيف',
      'app.title.dashboard': 'Offline Kahoot — الاختبارات',
      'app.title.player': 'Offline Kahoot — الانضمام',
      'app.title.login': 'Offline Kahoot — تسجيل الدخول',
      'app.title.editor': 'Offline Kahoot — المحرر',
      'word.question': 'سؤال',
      'word.points': '{points} نقطة',
      'common.quizCount': '{title} ({count} سؤال)',

      // Host page
      'host.join': 'انضم إلى اللعبة',
      'host.joinUrl': 'رابط الانضمام',
      'host.pin': 'رمز اللعبة',
      'host.scan': 'امسح رمز QR للانضمام',
      'host.qrAlt': 'رمز QR الذي يحتوي رابط الانضمام',
      'host.players': 'اللاعبون',
      'host.lobbyEmpty': 'بانتظار انضمام اللاعبين — شارك رمز اللعبة أو رمز QR.',
      'host.quiz': 'الاختبار',
      'host.chooseQuiz': 'اختر اختبارًا…',
      'host.exportQuiz': 'تصدير «{title}»',
      'host.startGame': 'ابدأ اللعبة',
      'host.timeLeft': 'الوقت المتبقي',
      'host.reveal': 'كشف الإجابة',
      'host.nextQuestion': 'السؤال التالي',
      'host.correctAnswer': 'الإجابة الصحيحة',
      'host.answeredCorrectly': 'أجابوا بشكل صحيح',
      'host.next': 'التالي',
      'host.option': 'خيار {number}',
      'host.leaderboard': 'لوحة النتائج',
      'host.podium': '🏆 المنصة',
      'host.backToLobby': 'العودة إلى لوحة التحكم',
      'host.dashboard': '‹ لوحة التحكم',
      'host.failedSession': 'تعذّر تحميل الجلسة في صفحة المضيف: {detail}',

      // Dashboard page (admin-dashboard issue 04)
      'dashboard.title': 'الاختبارات',
      'dashboard.live': 'اللعبة جارية — انضم برمز اللعبة {pin}',
      'dashboard.openHostLabel': 'افتح شاشة المضيف للعبة الحالية',
      'dashboard.logout': 'تسجيل الخروج',
      'dashboard.logoutFailed': 'تعذّر تسجيل الخروج: {detail}',
      'dashboard.create': 'إنشاء',
      'dashboard.start': 'ابدأ',
      'dashboard.import': 'استيراد',
      'dashboard.imported': 'تم استيراد اختبار: {title}',
      'dashboard.importedMany': 'تم استيراد {count} اختبارات.',
      'dashboard.importFailed': 'فشل الاستيراد: {detail}',
      'dashboard.importNotJson': 'فشل الاستيراد: الملف ليس JSON صالحًا.',
      'dashboard.questionCount': '{count} سؤال',
      'dashboard.edit': 'تحرير',
      'dashboard.delete': 'حذف',
      'dashboard.starting': 'جارٍ تحميل «{title}» — التوجّه إلى شاشة المضيف…',
      'dashboard.empty': 'لا توجد اختبارات بعد — أنشئ اختبارك الأول.',
      'dashboard.created': 'تم إنشاء اختبار: {title}',
      'dashboard.failedList': 'تعذّر عرض الاختبارات: {detail}',
      'dashboard.failedCreate': 'فشل الإنشاء: {detail}',
      'dashboard.failedStart': 'تعذّر البدء: {detail}',
      'dashboard.failedDelete': 'فشل الحذف: {detail}',

      // Login page
      'login.title': 'تسجيل الدخول',
      'login.password': 'كلمة مرور المسؤول',
      'login.submit': 'تسجيل الدخول',
      'login.submitting': 'جارِ تسجيل الدخول…',
      'login.err.wrongPassword': 'كلمة المرور خاطئة — حاول مرة أخرى',
      'login.err.network': 'تعذّر الاتصال بالخادم. هل أنت على شبكة Wi-Fi الخاصة بالمضيف؟',

      // Player page
      'player.joinTitle': 'انضم إلى اللعبة',
      'player.pinLabel': 'رمز اللعبة',
      'player.pinPlaceholder': '000000',
      'player.nameLabel': 'لقب اللاعب',
      'player.namePlaceholder': 'اللقب',
      'player.colorLabel': 'لون الصورة الرمزية',
      'player.color.red': 'أحمر',
      'player.color.orange': 'برتقالي',
      'player.color.blue': 'أزرق',
      'player.color.green': 'أخضر',
      'player.color.pink': 'وردي',
      'player.color.white': 'أبيض',
      'player.color.yellow': 'أصفر',
      'player.color.brown': 'بني',
      'player.color.black': 'أسود',
      'player.color.grey': 'رمادي',
      'player.join': 'انضم',
      'player.leave': 'مغادرة',
      'player.inTitle': 'أنت داخل اللعبة!',
      'player.playingAs': 'أنت',
      'player.waiting': 'بانتظار بدء المضيف…',
      'player.players': 'اللاعبون',
      'player.leaderboard': 'لوحة النتائج',
      'player.nextComing': 'السؤال التالي قادم…',
      'player.gameOver': '🏆 انتهت اللعبة!',
      'player.reconnecting': 'جارِ إعادة الاتصال…',
      'player.joining': 'جارِ الانضمام…',
      'player.inProgress': 'اللعبة جارية الآن…',
      'player.enterPin': 'أدخل رمز اللعبة المكوّن من 6 أرقام',
      'player.nameLength': 'يجب أن يتكوّن اللقب من 1 إلى 20 حرفًا',
      'player.noServer': 'لا يمكن الوصول إلى خادم اللعبة. هل أنت على شبكة Wi-Fi نفسها التي يستخدمها المضيف؟',
      'player.timeout': 'انتهت مهلة الاتصال — تأكد من أن حاسوب المضيف يعمل وعلى الشبكة نفسها.',
      'player.lostConnection': 'انقطع الاتصال بخادم اللعبة.',
      'player.answerLocked': 'تم تسجيل إجابتك!',
      'player.correct': 'إجابة صحيحة!',
      'player.incorrect': 'إجابة خاطئة',
      'player.correctAnswer': 'الإجابة الصحيحة: {answer}',
      'player.rank': 'أنت في المركز #{rank} من {total}',
      'player.rankWaiting': 'بانتظار النتائج…',
      'player.err.bad-pin': 'رمز اللعبة غير صحيح — تحقق من شاشة المضيف',
      'player.err.bad-name': 'يجب أن يتكوّن اللقب من 1 إلى 20 حرفًا',
      'player.err.nameTaken': 'هذا اللقب مستخدم — اختر لقبًا آخر',
      'player.err.colorRejected': 'اختر لونًا للصورة الرمزية ثم انضم مرة أخرى',
      'player.err.game-started': 'بدأت اللعبة بالفعل — أُغلق الانضمام',
      'player.err.default': 'تعذّر الانضمام — تحقق من الرمز وحاول مرة أخرى',
      'player.rej.late': 'متأخر جدًا — أُغلقت الإجابات لهذا السؤال',
      'player.rej.already-answered': 'لقد أجبت على هذا السؤال بالفعل',
      'player.rej.unknown-player': 'تعذّر تسجيل الإجابة — انقطع اتصالك مؤقتًا',
      'player.rej.invalid-answer': 'هذه الإجابة غير صالحة',
      'player.rej.default': 'تم رفض الإجابة',

      // Editor page
      'editor.title': 'محرر الاختبارات',
      'editor.quizzes': 'الاختبارات',
      'editor.noQuizzes': 'لا توجد اختبارات بعد — أنشئ اختبارًا أدناه.',
      'editor.newQuiz': 'اختبار جديد',
      'editor.titlePlaceholder': 'عنوان الاختبار',
      'editor.create': 'إنشاء اختبار',
      'editor.back': '‹ الرجوع إلى لوحة التحكم',
      'editor.editing': 'تحرير الاختبار',
      'editor.rename': 'إعادة تسمية',
      'editor.deleteQuiz': 'حذف الاختبار',
      'editor.backShort': '‹ رجوع',
      'editor.questions': 'الأسئلة',
      'editor.addQuestion': '＋ إضافة سؤال',
      'editor.save': '💾 حفظ الاختبار',
      'editor.question': 'سؤال {number}',
      'editor.removeQuestion': 'إزالة هذا السؤال',
      'editor.prompt': 'نص السؤال',
      'editor.type': 'النوع',
      'editor.typeMultiple': 'اختيار من متعدد',
      'editor.typeTrueFalse': 'صح أم خطأ',
      'editor.timer': 'المؤقّت (ثوانٍ)',
      'editor.correctAnswer': 'الإجابة الصحيحة',
      'editor.optionsCorrect': 'الخيارات (حدّد نقطة الاختيار على الإجابة الصحيحة)',
      'editor.addOption': '＋ إضافة خيار',
      'editor.option': 'خيار {number}',
      'editor.removeOption': 'إزالة هذا الخيار',
      'editor.saved': 'تم الحفظ. سيرى المضيف هذا الاختبار عند إعادة تحميل صفحته.',
      'editor.renamed': 'أُعيدت التسمية إلى «{title}»',
      'editor.deleteConfirm': 'حذف اختبار «{title}»؟ لا يمكن التراجع عن هذه العملية.',
      'editor.deleted': 'حُذف اختبار «{title}»',
      'editor.giveTitle': 'أعطِ الاختبار الجديد عنوانًا أولًا.',
      'editor.createFailed': 'فشل الإنشاء: {detail}',
      'editor.failedList': 'تعذّر عرض الاختبارات: {detail}',
      'editor.failedLoad': 'تعذّر تحميل الاختبار: {detail}',
      'editor.err.title': 'العنوان: يجب أن يكون نصًا غير فارغ',
      'editor.err.prompt': 'سؤال {number}: يجب ألا يكون نص السؤال فارغًا',
      'editor.err.timer': 'سؤال {number}: يجب أن يكون المؤقّت عددًا موجبًا من الثواني',
      'editor.err.options': 'سؤال {number}: يحتاج من 2 إلى 4 خيارات غير فارغة',
      'editor.err.correct': 'سؤال {number}: يجب تحديد الإجابة الصحيحة',
    },
  };

  // DORMANT (translation UI removed): language pinned to English; see
  // detectLang() below to restore auto-detection / stored choice.
  let lang = 'en';
  // let lang = detectLang();
  /** page hooks registered with onChange(): rebuild dynamic screens. */
  const changeListeners = new Set();
  /** element -> { key, params }; set() records here so a language toggle
   *  transparently re-translates dynamic status lines. */
  const tracked = new Map();

  function detectLang() {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      if (stored === 'en' || stored === 'ar') return stored;
    } catch {
      // storage unavailable (e.g. private mode); fall through to detection
    }
    const prefs = navigator.languages ?? [navigator.language ?? 'en'];
    if (prefs.some((p) => typeof p === 'string' && p.toLowerCase().startsWith('ar'))) return 'ar';
    return 'en';
  }

  /** Translate a key; {param} placeholders are replaced from `params`. */
  function t(key, params) {
    const map = STRINGS[lang] ?? STRINGS.en;
    const text = map[key] ?? STRINGS.en[key];
    if (text === undefined) return `MISSING-I18N:${key}`; // loud, never blank
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
    );
  }

  /** Set dynamic text: keeps the element tracked for language changes. */
  function set(el, key, params) {
    tracked.set(el, { key, params });
    el.textContent = t(key, params);
  }

  /** Clear dynamic text and stop tracking the element. */
  function clear(el) {
    tracked.delete(el);
    el.textContent = '';
  }

  /** Re-apply data-i18n / data-i18n-attr inside `root` (whole document by default). */
  function applyStatic(root = document) {
    for (const node of root.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of root.querySelectorAll('[data-i18n-attr]')) {
      // Syntax: attribute:key;attribute2:key2
      for (const spec of node.dataset.i18nAttr.split(';')) {
        const [attr, key] = spec.split(':').map((part) => part.trim());
        if (attr && key) node.setAttribute(attr, t(key));
      }
    }
  }

  function setDirection() {
    const root = document.documentElement;
    root.lang = lang;
    if (lang === 'ar') root.setAttribute('dir', 'rtl');
    else root.removeAttribute('dir');
  }

  function updateToggle(toggle) {
    for (const button of toggle.querySelectorAll('button')) {
      const active = button.dataset.lang === lang;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function buildToggle() {
    const toggle = document.createElement('div');
    toggle.className = 'lang-toggle';
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Language / اللغة');
    for (const [code, label] of [
      ['en', 'EN'],
      ['ar', 'عربي'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.lang = code;
      button.textContent = label;
      button.addEventListener('click', () => setLang(code));
      toggle.append(button);
    }
    document.body.append(toggle);
    updateToggle(toggle);
  }

  // DORMANT (translation UI removed): EN/AR switch no longer injected on
  // pages. Re-enable this call in the init block at the bottom to restore it.
  // buildToggle();

  function setLang(next) {
    if (next !== 'en' && next !== 'ar') return;
    lang = next;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // volatile choice is fine when storage is unavailable
    }
    setDirection();
    applyStatic();
    for (const [el, entry] of tracked) el.textContent = t(entry.key, entry.params);
    for (const listener of changeListeners) listener();
    const toggle = document.querySelector('.lang-toggle');
    if (toggle) updateToggle(toggle);
  }

  function getLang() {
    return lang;
  }

  function onChange(listener) {
    changeListeners.add(listener);
  }

  setDirection();
  applyStatic();
  // DORMANT (translation UI removed): see buildToggle() above.
  // buildToggle();

  window.I18n = { t, set, clear, applyStatic, getLang, setLang, onChange };
  // Bare `t` is the workhorse inside page scripts.
  window.t = t;
})();
