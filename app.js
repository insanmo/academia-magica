const { SUPABASE_URL, SUPABASE_ANON_KEY, CERT_UPLOAD_URL, ALLOWED_DOMAIN } = window.ACADEMY_CONFIG || {};

const CONFIG = {
  passGrade: 15,
  pointsPerCourse: 50,
  xpPerCourse: 100,
  certUploadUrl: CERT_UPLOAD_URL || "https://indra365.sharepoint.com/"
};

let sb = null;
let currentSession = null;
let me = null;
let houses = [];
let courses = [];
let progress = [];
let activeQuiz = null;
let quizTimer = null;
let toastTimer = null;
let toastHideTimer = null;

const $ = id => document.getElementById(id);

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.value !== undefined) node.value = String(options.value);
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.href) node.href = options.href;
  if (options.target) node.target = options.target;
  if (options.rel) node.rel = options.rel;
  children.forEach(child => node.append(child));
  return node;
}

function clear(node) {
  node.replaceChildren();
  return node;
}

function toast(message, type = "info", duration = 7000) {
  const node = $("toast");
  window.clearTimeout(toastTimer);
  window.clearTimeout(toastHideTimer);
  node.textContent = message;
  node.className = `toast ${type}`;
  requestAnimationFrame(() => node.classList.add("show"));
  toastTimer = window.setTimeout(() => {
    node.classList.remove("show");
    toastHideTimer = window.setTimeout(() => node.classList.add("hidden"), 450);
  }, duration);
}

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function isAllowedEmail(email) {
  return normalizeEmail(email).endsWith(`@${ALLOWED_DOMAIN}`);
}

function safeHttpUrl(value, requiredHostSuffix = "") {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (requiredHostSuffix && host !== requiredHostSuffix && !host.endsWith(`.${requiredHostSuffix}`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("es-PE") : "-";
}

function formatSeconds(seconds) {
  if (!seconds && seconds !== 0) return "-";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function level(xp) {
  if (xp >= 600) return "Gran Mago";
  if (xp >= 450) return "Maestro";
  if (xp >= 300) return "Prefecto";
  if (xp >= 200) return "Estudiante destacado";
  if (xp >= 100) return "Alumno";
  return "Aprendiz";
}

async function loginWithPassword() {
  const button = $("loginBtn");
  const email = normalizeEmail($("loginEmail").value);
  const password = $("loginPassword").value;
  if (!isAllowedEmail(email)) {
    toast("Solo se permite ingreso con correo corporativo Indra.", "warning");
    return;
  }
  if (!password) {
    toast("Ingresa tu contraseña para continuar.", "warning");
    return;
  }
  button.disabled = true;
  button.textContent = "Verificando...";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  button.disabled = false;
  button.textContent = "Ingresar a la Academia";
  if (error) {
    console.error(error);
    const message = error.message?.toLowerCase() || "";
    if (message.includes("email not confirmed")) {
      toast("Tu correo todavía no está confirmado. Revisa el mensaje enviado por Supabase.", "warning", 9000);
    } else {
      toast("El correo o la contraseña no coinciden. Si acabas de recuperarla, usa exactamente la nueva contraseña.", "error", 9000);
    }
    return;
  }
  location.reload();
}

async function registerWithPassword() {
  const fullName = $("registerName").value.trim();
  const email = normalizeEmail($("registerEmail").value);
  const password = $("registerPassword").value;
  const houseId = $("registerHouse").value;
  if (fullName.length < 3 || !isAllowedEmail(email) || !houseId) {
    toast("Completa nombre, correo Indra y casa.");
    return;
  }
  if (currentSession) {
    await registerProfile(fullName, email, houseId);
    return;
  }
  if (password.length < 8) {
    toast("La contraseña debe tener mínimo 8 caracteres.");
    return;
  }
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      data: { academy_full_name: fullName, academy_house_id: houseId }
    }
  });
  if (error) {
    console.error(error);
    toast("No se pudo crear la cuenta. El correo puede estar registrado.");
    return;
  }
  if (!data.session) {
    toast("Revisa tu correo para confirmar la cuenta y luego inicia sesión.");
    showLogin();
    return;
  }
  await registerProfile(fullName, email, houseId);
}

async function registerProfile(fullName, email, houseId) {
  const { error } = await sb.rpc("academy_register_user", {
    p_full_name: fullName,
    p_indra_email: email,
    p_house_id: houseId
  });
  if (error) {
    console.error(error);
    toast(error.message.includes("disabled") ? "Esta cuenta fue deshabilitada por un focal." : "No se pudo enlazar el perfil.");
    return;
  }
  currentSession = (await sb.auth.getSession()).data.session;
  me = await getProfileByAuth();
  if (me.role === "student" && !me.admission_letter_seen) showLetter();
  else await showApp();
}

async function requestPasswordReset(emailValue = null) {
  const email = normalizeEmail(emailValue || $("loginEmail").value);
  if (!isAllowedEmail(email)) {
    toast("Ingresa primero un correo Indra válido.", "warning");
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname
  });
  if (error) {
    console.error(error);
    toast("No se pudo enviar el enlace de recuperación. Verifica el correo e inténtalo nuevamente.", "error", 9000);
    return;
  }
  toast("Enviamos un enlace para cambiar la contraseña. Revisa también tu carpeta de correo no deseado.", "success", 10000);
}

async function initSession() {
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  currentSession = data.session;
  if (!currentSession) {
    showLogin();
    return;
  }

  if (window.location.hash.includes("type=recovery")) {
    showResetPassword();
    return;
  }
  const accessRes = await sb.rpc("academy_my_access_status");
  if (accessRes.error) throw accessRes.error;
  if (accessRes.data === "disabled") {
    await sb.auth.signOut();
    toast("Tu cuenta fue deshabilitada por un focal.");
    return;
  }
  await loadHouses();
  me = await getProfileByAuth();
  if (!me) {
    const metadata = currentSession.user.user_metadata || {};
    if (metadata.academy_full_name && metadata.academy_house_id) {
      await registerProfile(metadata.academy_full_name, currentSession.user.email, metadata.academy_house_id);
      return;
    }
    toast("Completa el registro de tu perfil.");
    showRegister(currentSession.user.email);
    return;
  }
  if (!me.admission_letter_seen && me.role === "student") showLetter();
  else await showApp();
}

async function loadHouses() {
  const { data, error } = await sb.from("academy_houses").select("*").order("name");
  if (error) throw error;
  houses = data || [];
}

async function getProfileByAuth() {
  const { data, error } = await sb
    .from("academy_users")
    .select("*, house:academy_houses(*)")
    .eq("auth_user_id", currentSession.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function showLogin() {
  $("authScreen").classList.remove("hidden");
  $("loginBox").classList.remove("hidden");
  $("registerBox").classList.add("hidden");
  $("resetPasswordBox").classList.add("hidden");
}

async function showRegister(email = "") {
  await loadHouses();
  $("authScreen").classList.remove("hidden");
  $("loginBox").classList.add("hidden");
  $("registerBox").classList.remove("hidden");
  $("resetPasswordBox").classList.add("hidden");
  $("registerEmail").value = email || $("loginEmail").value;
  $("registerEmail").disabled = Boolean(currentSession);
  const select = clear($("registerHouse"));
  houses.forEach(house => select.append(element("option", { value: house.id, text: `${house.icon || ""} ${house.name}` })));
  updateLeaderPreview();
}

function updateLeaderPreview() {
  const house = houses.find(item => item.id === $("registerHouse").value);
  $("leaderPreview").textContent = house?.leader_name || "-";
}

function showResetPassword() {
  $("authScreen").classList.remove("hidden");
  $("loginBox").classList.add("hidden");
  $("registerBox").classList.add("hidden");
  $("resetPasswordBox").classList.remove("hidden");
}

async function saveNewPassword(firstId, confirmId, closeDialog = false) {
  const button = closeDialog ? $("saveAccountPasswordBtn") : $("saveNewPasswordBtn");
  const password = $(firstId).value;
  if (password.length < 8 || password !== $(confirmId).value) {
    toast("Las contraseñas deben coincidir y tener mínimo 8 caracteres.", "warning");
    return;
  }
  button.disabled = true;
  const { data, error } = await sb.auth.updateUser({ password });
  if (error) {
    button.disabled = false;
    console.error(error);
    toast("No se pudo cambiar la contraseña. Intenta solicitar un nuevo enlace de recuperación.", "error", 9000);
    return;
  }
  const recoveryEmail = data.user?.email || currentSession?.user?.email || "";
  if (closeDialog) {
    button.disabled = false;
    $("passwordDialog").close();
    toast("Contraseña actualizada correctamente.", "success");
    return;
  }
  await sb.auth.signOut({ scope: "local" });
  currentSession = null;
  history.replaceState({}, document.title, window.location.pathname);
  showLogin();
  $("loginEmail").value = recoveryEmail;
  $("loginPassword").value = "";
  toast("Contraseña actualizada. Inicia sesión nuevamente con tu nueva contraseña.", "success", 10000);
}

function showLetter() {
  $("authScreen").classList.add("hidden");
  $("letterLeader").textContent = me.house?.leader_name || "Lider de casa";
  $("letterModal").classList.remove("hidden");
}

async function acceptLetter() {
  const { error } = await sb.rpc("academy_accept_letter");
  if (error) {
    console.error(error);
    toast("No se pudo actualizar la carta.");
    return;
  }
  me.admission_letter_seen = true;
  $("letterModal").classList.add("hidden");
  await showApp();
}

async function showApp() {
  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  await loadDashboardData();
  await renderAll();
}

async function loadDashboardData() {
  await loadHouses();
  const [courseRes, progressRes] = await Promise.all([
    sb.from("academy_courses").select("*").eq("active", true).order("sort_order"),
    sb.from("academy_progress").select("*, course:academy_courses(*)").eq("user_id", me.id)
  ]);
  if (courseRes.error) throw courseRes.error;
  if (progressRes.error) throw progressRes.error;
  courses = courseRes.data || [];
  progress = progressRes.data || [];
}

function completedCount() {
  return progress.filter(item => item.completed).length;
}

function myPoints() {
  if (me.role !== "student") return 0;
  return progress.filter(item => item.completed).reduce((sum, item) => sum + (item.course?.points || CONFIG.pointsPerCourse), 0);
}

function myXp() {
  return progress.filter(item => item.completed).reduce((sum, item) => sum + (item.course?.xp || CONFIG.xpPerCourse), 0);
}

function getProgress(courseId) {
  return progress.find(item => item.course_id === courseId);
}

async function renderAll() {
  renderProfile();
  renderCourses();
  renderBadges();
  await renderCup();
}

function renderProfile() {
  const house = me.house;
  const xp = myXp();
  $("profileIcon").textContent = house?.icon || "★";
  $("sideName").textContent = me.full_name;
  $("sideMeta").textContent = `${house?.name || "-"} · Lider: ${house?.leader_name || "-"}`;
  $("sideRole").textContent = me.role === "focal" ? "Focal" : "Participante";
  $("charIcon").textContent = house?.icon || "★";
  $("charName").textContent = me.full_name;
  $("charEmail").textContent = me.indra_email;
  $("charHouse").textContent = `Casa ${house?.name || "-"}`;
  $("charLeader").textContent = `Lider: ${house?.leader_name || "-"}`;
  $("charXp").textContent = xp;
  $("charPoints").textContent = myPoints();
  $("charLevel").textContent = level(xp);
  $("xpText").textContent = `${xp} XP`;
  $("levelText").textContent = level(xp);
  $("progressText").textContent = `${completedCount()}/${courses.length}`;
  $("progressFill").style.width = `${courses.length ? Math.round(completedCount() / courses.length * 100) : 0}%`;
  $("adminLink").classList.toggle("hidden", me.role !== "focal");
}

async function renderCup() {
  const { data, error } = await sb.rpc("academy_get_house_scores");
  if (error) throw error;
  const grid = clear($("housesGrid"));
  (data || []).sort((a, b) => b.total_points - a.total_points).forEach((row, index) => {
    const house = houses.find(item => item.name === row.house);
    const card = element("article", { className: "house-card" });
    card.style.setProperty("--grad", houseGradient(row.house));
    card.append(
      element("div", { className: "house-icon", text: house?.icon || "★" }),
      element("p", { className: "overline", text: `Puesto ${index + 1}` }),
      element("h3", { text: row.house }),
      element("p", { text: `Lider: ${row.leader_name}` }),
      element("div", { className: "house-points", text: `${row.total_points} pts` })
    );
    if (me.house?.name === row.house) card.append(element("div", { className: "your-points", text: `Tu aporte valido: ${myPoints()} pts` }));
    grid.append(card);
  });
}

function houseGradient(name) {
  return {
    Gryffindor: "linear-gradient(135deg,#d83a3a,#f2c14e)",
    Hufflepuff: "linear-gradient(135deg,#f2c14e,#191919)",
    Slytherin: "linear-gradient(135deg,#168b5a,#cfd8d4)",
    Ravenclaw: "linear-gradient(135deg,#2f66d0,#c9d6ff)",
    Thunderbird: "linear-gradient(135deg,#7b3ff2,#19c7c9,#f2c14e)"
  }[name] || "linear-gradient(135deg,#ffd579,#7e47d8)";
}

function actionLink(text, href) {
  const safeUrl = safeHttpUrl(href);
  const link = element("a", { className: "secondary", text, href: safeUrl || "#", target: "_blank", rel: "noopener noreferrer" });
  if (!safeUrl) link.addEventListener("click", event => event.preventDefault());
  return link;
}

function renderCourses() {
  const grid = clear($("coursesGrid"));
  courses.forEach((course, index) => {
    const item = getProgress(course.id);
    const done = Boolean(item?.completed);
    const card = element("article", { className: "course-card" });
    const head = element("div", { className: "course-head" }, [
      element("div", { className: "num", text: String(index + 1).padStart(2, "0") }),
      element("span", { className: `state ${done ? "done" : "pending"}`, text: done ? "Aprobado" : "Pendiente" })
    ]);
    const stats = `Intentos: ${item?.attempts || 0}${item?.best_score !== null && item?.best_score !== undefined ? ` · Mejor nota: ${item.best_score}` : ""}${item?.best_quiz_time_seconds ? ` · Tiempo: ${formatSeconds(item.best_quiz_time_seconds)}` : ""}`;
    const actions = element("div", { className: "course-actions" });
    const quizButton = element("button", { className: "secondary", text: "Dar examen", type: "button" });
    quizButton.onclick = () => openQuiz(course.id);
    actions.append(actionLink("Ir al curso", course.udemy_url), actionLink("Registrar certificado", CONFIG.certUploadUrl), quizButton);

    const certArea = element("div", { className: "cert-area" });
    const input = element("input", { value: item?.certificate_url || "", placeholder: "Pega aqui el link del certificado" });
    input.id = `cert-${course.id}`;
    const saveButton = element("button", { className: "secondary", text: "Guardar certificado", type: "button" });
    saveButton.onclick = () => saveCertificate(course.id);
    certArea.append(element("small", { text: "Luego pega aqui el link del certificado en SharePoint" }), input, saveButton);
    card.append(head, element("h3", { text: course.title }), element("p", { text: `Curso Udemy: ${course.udemy_name || course.title}` }), element("p", { text: course.description || "" }), element("p", { text: stats }), actions, certArea);
    grid.append(card);
  });
}

async function saveCertificate(courseId) {
  const url = safeHttpUrl($(`cert-${courseId}`).value.trim(), "sharepoint.com");
  if (!url) {
    toast("Pega un enlace HTTPS valido de SharePoint.");
    return;
  }
  const { error } = await sb.rpc("academy_save_certificate", { p_course_id: courseId, p_certificate_url: url });
  if (error) {
    console.error(error);
    toast("No se pudo guardar el certificado.");
    return;
  }
  toast("Certificado registrado.");
  await refreshDashboard();
}

async function openQuiz(courseId) {
  const { data, error } = await sb.rpc("academy_start_quiz", { p_course_id: courseId });
  if (error) {
    console.error(error);
    toast(error.message.includes("certificate") ? "Primero registra el certificado." : "No se pudo iniciar el examen.");
    return;
  }
  activeQuiz = data;
  renderQuiz(data.questions || []);
  $("quizDialog").showModal();
  startTimer(Number(data.expires_in_seconds) || 180);
}

function renderQuiz(questions) {
  const content = clear($("quizContent"));
  const timer = element("div", { className: "timer", text: "Tiempo restante: 03:00" });
  timer.id = "timer";
  content.append(timer, element("h2", { text: "Examen" }), element("p", { text: `Nota minima aprobatoria: ${CONFIG.passGrade}.` }));
  questions.forEach((question, index) => {
    const block = element("div", { className: "question" }, [element("strong", { text: `${index + 1}. ${question.question_text}` })]);
    (question.options || []).forEach((option, optionIndex) => {
      const radio = element("input", { type: "radio", value: optionIndex });
      radio.name = `question-${question.id}`;
      block.append(element("label", {}, [radio, document.createTextNode(` ${option}`)]));
    });
    content.append(block);
  });
  const submit = element("button", { className: "primary", text: "Enviar examen", type: "button" });
  submit.onclick = gradeQuiz;
  content.append(submit);
}

function startTimer(seconds) {
  clearInterval(quizTimer);
  let remaining = seconds;
  quizTimer = setInterval(() => {
    remaining -= 1;
    const timer = $("timer");
    if (timer) timer.textContent = `Tiempo restante: ${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining <= 0) {
      clearInterval(quizTimer);
      $("quizDialog").close();
      activeQuiz = null;
      toast("Tiempo finalizado. Puedes volver a intentarlo.");
    }
  }, 1000);
}

async function gradeQuiz() {
  const answers = (activeQuiz.questions || []).map(question => {
    const selected = document.querySelector(`input[name="question-${question.id}"]:checked`);
    return selected ? { question_id: question.id, selected_option: Number(selected.value) } : null;
  });
  if (answers.some(answer => !answer)) {
    toast("Responde todas las preguntas.");
    return;
  }

  const { data, error } = await sb.rpc("academy_submit_attempt", {
    p_session_id: activeQuiz.session_id,
    p_answers: answers
  });
  if (error) {
    console.error(error);
    toast(error.message.includes("expired") ? "El tiempo del examen termino." : "No se pudo registrar el intento.");
    return;
  }
  clearInterval(quizTimer);
  $("quizDialog").close();
  activeQuiz = null;
  toast(data.passed ? `Aprobaste con nota ${data.score}.` : `Nota ${data.score}. Puedes volver a intentarlo.`);
  await refreshDashboard();
}

function renderBadges() {
  const xp = myXp();
  const items = [
    ["★", "Primer Hechizo", completedCount() >= 1],
    ["⚡", "Ruta en Marcha", completedCount() >= 3],
    ["★", "Prefecto/a", xp >= 300],
    ["♛", "Gran Mago de las Habilidades Blandas", completedCount() === courses.length],
    ["✉", "Mensajero de las Casas", isCourseCompleted("comunicacion")],
    ["♧", "Guardian de la Resiliencia", isCourseCompleted("resiliencia")],
    ["⌚", "Custodio del Tiempo", isCourseCompleted("organizacion")],
    ["♬", "Cronista Magico", isCourseCompleted("storytelling")]
  ];
  const grid = clear($("badgesGrid"));
  items.forEach(item => grid.append(element("article", { className: `badge ${item[2] ? "unlocked" : ""}` }, [
    element("div", { className: "badge-icon", text: item[0] }),
    element("h3", { text: item[1] }),
    element("p", { text: item[2] ? "Desbloqueada" : "Pendiente" })
  ])));
}

function isCourseCompleted(code) {
  const course = courses.find(item => item.code === code);
  return course ? Boolean(getProgress(course.id)?.completed) : false;
}

async function renderAdminIfAllowed() {
  if (me.role === "focal") await renderAdmin();
}

function appendCell(row, text) {
  row.append(element("td", { text: text ?? "-" }));
}

async function renderAdmin() {
  const [summaryRes, detailRes, scoresRes] = await Promise.all([
    sb.rpc("academy_get_admin_summary"),
    sb.rpc("academy_get_admin_course_detail"),
    sb.rpc("academy_get_house_scores")
  ]);
  if (summaryRes.error || detailRes.error || scoresRes.error) throw summaryRes.error || detailRes.error || scoresRes.error;
  const filterHouse = adminFilter === "mine" ? me.house.name : null;
  const summary = (summaryRes.data || []).filter(row => !filterHouse || row.house === filterHouse);
  const detail = (detailRes.data || []).filter(row => !filterHouse || row.house === filterHouse);
  const topHouse = (scoresRes.data || []).sort((a, b) => b.total_points - a.total_points)[0];
  const topWizard = summary.filter(row => row.role === "student" && row.active).sort((a, b) => b.valid_points - a.valid_points)[0];
  $("adminParticipants").textContent = summary.filter(row => row.role === "student").length;
  $("adminTopHouse").textContent = topHouse ? `${topHouse.house} (${topHouse.total_points})` : "-";
  $("adminTopWizard").textContent = topWizard?.full_name || "-";
  $("adminFilterLabel").textContent = filterHouse || "Todas";

  const summaryBody = clear($("adminRows"));
  summary.forEach(item => {
    const row = element("tr");
    [item.full_name, item.indra_email, item.role === "focal" ? "Focal" : "Participante", item.active ? "Activo" : "Deshabilitado", item.house, item.leader_name, `${item.completed_courses}/${courses.length}`, item.valid_points, item.xp].forEach(value => appendCell(row, value));
    const actionCell = element("td", { text: "-" });
    const actions = element("div", { className: "admin-actions" });
    if (item.role === "student") {
      const toggleButton = element("button", {
        className: item.active ? "danger" : "secondary",
        text: item.active ? "Deshabilitar" : "Habilitar",
        type: "button"
      });
      toggleButton.onclick = () => setParticipantActive(item.user_id, !item.active);
      actions.append(toggleButton);
    }
    const resetButton = element("button", { className: "secondary", text: "Enviar recuperación", type: "button" });
    resetButton.onclick = () => requestPasswordReset(item.indra_email);
    actions.append(resetButton);
    actionCell.replaceChildren(actions);
    row.append(actionCell);
    summaryBody.append(row);
  });

  const detailBody = clear($("adminCourseRows"));
  detail.forEach(item => {
    const row = element("tr");
    [item.full_name, item.course_title, item.completed ? "Aprobado" : "Pendiente", item.best_score, item.attempts ?? 0, formatDate(item.completed_at), formatSeconds(item.best_quiz_time_seconds)].forEach(value => appendCell(row, value));
    const certCell = element("td", { text: "-" });
    const certUrl = safeHttpUrl(item.certificate_url || "", "sharepoint.com");
    if (certUrl) certCell.replaceChildren(actionLink("Ver", certUrl));
    row.append(certCell);
    detailBody.append(row);
  });

  await renderQuestionAdmin();
}

async function setParticipantActive(userId, active) {
  const action = active ? "habilitar" : "deshabilitar";
  if (!window.confirm(`¿Seguro que deseas ${action} este participante?`)) return;
  const { error } = await sb.rpc("academy_admin_set_participant_active", {
    p_user_id: userId,
    p_active: active
  });
  if (error) {
    console.error(error);
    toast(`No se pudo ${action} el participante.`);
    return;
  }
  toast(`Participante ${active ? "habilitado" : "deshabilitado"}.`);
  await renderAdmin();
}

async function renderQuestionAdmin() {
  const courseSelect = $("questionCourseSelect");
  const selectedCourseId = courseSelect.value || courses[0]?.id;
  clear(courseSelect);
  courses.forEach(course => courseSelect.append(element("option", { value: course.id, text: course.title })));
  if (!selectedCourseId) {
    clear($("questionEditor"));
    clear($("questionList")).append(element("div", { className: "empty-state", text: "No hay cursos configurados." }));
    return;
  }
  courseSelect.value = selectedCourseId;

  const { data, error } = await sb.rpc("academy_admin_get_questions", { p_course_id: selectedCourseId });
  if (error) throw error;
  adminQuestions = data || [];
  renderQuestionEditor();
  renderQuestionList();
}

function renderQuestionEditor(question = null) {
  const container = clear($("questionEditor"));
  const courseId = $("questionCourseSelect").value;
  if (!courseId) return;

  const form = element("form", { className: "question-form" });
  const textInput = element("textarea", { placeholder: "Escribe la pregunta" });
  textInput.rows = 3;
  textInput.value = question?.question_text || "";
  const orderInput = element("input", {
    type: "number",
    value: question?.sort_order || Math.max(0, ...adminQuestions.map(item => item.sort_order)) + 1
  });
  orderInput.min = "1";
  orderInput.max = "999";
  const activeInput = element("input", { type: "checkbox" });
  activeInput.checked = question?.active ?? true;

  const optionsBox = element("div", { className: "question-options" });
  const optionValues = question?.options?.length ? question.options : ["", "", ""];
  optionValues.forEach((value, index) => addQuestionOptionRow(optionsBox, value, index === (question?.correct_option ?? 0)));

  const addOptionButton = element("button", { className: "secondary", text: "Agregar opcion", type: "button" });
  addOptionButton.onclick = () => {
    if (optionsBox.children.length >= 6) {
      toast("Cada pregunta puede tener hasta 6 opciones.");
      return;
    }
    addQuestionOptionRow(optionsBox, "", false);
  };

  const saveButton = element("button", { className: "primary", text: question ? "Guardar cambios" : "Crear pregunta", type: "submit" });
  const cancelButton = element("button", { className: "secondary", text: "Cancelar", type: "button" });
  cancelButton.onclick = () => renderQuestionEditor();
  const actions = element("div", { className: "admin-actions" }, [saveButton]);
  if (question) actions.append(cancelButton);

  const settings = element("div", { className: "question-form-grid" }, [
    element("label", {}, [document.createTextNode("Pregunta"), textInput]),
    element("label", {}, [document.createTextNode("Orden"), orderInput]),
    element("label", {}, [activeInput, document.createTextNode(" Pregunta activa")])
  ]);
  form.append(settings, element("strong", { text: "Opciones: selecciona la respuesta correcta" }), optionsBox, addOptionButton, actions);
  form.onsubmit = event => saveAdminQuestion(event, question?.id || null, textInput, optionsBox, activeInput, orderInput);
  container.append(form);
}

function addQuestionOptionRow(container, value, checked) {
  const row = element("div", { className: "question-option-row" });
  const radio = element("input", { type: "radio" });
  radio.name = "correctQuestionOption";
  radio.checked = checked;
  const input = element("input", { type: "text", value, placeholder: `Opcion ${container.children.length + 1}` });
  const removeButton = element("button", { className: "secondary", text: "Quitar", type: "button" });
  removeButton.onclick = () => {
    if (container.children.length <= 2) {
      toast("Cada pregunta necesita al menos 2 opciones.");
      return;
    }
    row.remove();
  };
  row.append(radio, input, removeButton);
  container.append(row);
}

async function saveAdminQuestion(event, questionId, textInput, optionsBox, activeInput, orderInput) {
  event.preventDefault();
  const optionRows = [...optionsBox.children];
  const options = optionRows.map(row => row.querySelector("input[type=text]").value.trim());
  const correctOption = optionRows.findIndex(row => row.querySelector("input[type=radio]").checked);
  if (textInput.value.trim().length < 5 || options.some(option => !option) || correctOption < 0) {
    toast("Completa la pregunta, todas las opciones y marca la respuesta correcta.");
    return;
  }

  const { error } = await sb.rpc("academy_admin_save_question", {
    p_question_id: questionId,
    p_course_id: $("questionCourseSelect").value,
    p_question_text: textInput.value.trim(),
    p_options: options,
    p_correct_option: correctOption,
    p_active: activeInput.checked,
    p_sort_order: Number(orderInput.value)
  });
  if (error) {
    console.error(error);
    toast(error.message.includes("sort order") ? "Ese numero de orden ya esta usado." : "No se pudo guardar la pregunta.");
    return;
  }
  toast(questionId ? "Pregunta actualizada." : "Pregunta creada.");
  await renderQuestionAdmin();
}

function renderQuestionList() {
  const list = clear($("questionList"));
  if (!adminQuestions.length) {
    list.append(element("div", { className: "empty-state", text: "Este curso aun no tiene preguntas. Crea la primera arriba." }));
    return;
  }
  adminQuestions.forEach(question => {
    const item = element("article", { className: "question-item" });
    const editButton = element("button", { className: "secondary", text: "Editar", type: "button" });
    editButton.onclick = () => renderQuestionEditor(question);
    const deleteButton = element("button", { className: "danger", text: "Eliminar", type: "button" });
    deleteButton.onclick = () => deleteAdminQuestion(question.id);
    const header = element("div", { className: "question-item-head" }, [
      element("div", {}, [
        element("span", { className: "question-status", text: `${question.active ? "Activa" : "Inactiva"} · Orden ${question.sort_order}` }),
        element("h4", { text: question.question_text })
      ]),
      element("div", { className: "admin-actions" }, [editButton, deleteButton])
    ]);
    const options = element("ol");
    question.options.forEach((option, index) => options.append(element("li", { className: index === question.correct_option ? "correct" : "", text: option })));
    item.append(header, options);
    list.append(item);
  });
}

async function deleteAdminQuestion(questionId) {
  if (!window.confirm("¿Eliminar esta pregunta permanentemente?")) return;
  const { error } = await sb.rpc("academy_admin_delete_question", { p_question_id: questionId });
  if (error) {
    console.error(error);
    toast("No se pudo eliminar la pregunta.");
    return;
  }
  toast("Pregunta eliminada.");
  await renderQuestionAdmin();
}

async function refreshDashboard() {
  await loadDashboardData();
  await renderAll();
}

async function logout() {
  await sb.auth.signOut();
  location.reload();
}

async function init() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes("PEGA_AQUI") || SUPABASE_ANON_KEY.includes("PEGA_AQUI")) {
    $("authScreen").classList.remove("hidden");
    toast("Falta configurar config.js con Supabase.");
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((event, session) => {
    currentSession = session;
    if (event === "PASSWORD_RECOVERY") showResetPassword();
  });
  $("loginBtn").onclick = loginWithPassword;
  $("loginPassword").onkeydown = event => {
    if (event.key === "Enter") loginWithPassword();
  };
  $("showLoginPassword").onchange = event => {
    $("loginPassword").type = event.target.checked ? "text" : "password";
  };
  $("showRecoveryPasswords").onchange = event => {
    const type = event.target.checked ? "text" : "password";
    $("newPassword").type = type;
    $("confirmNewPassword").type = type;
  };
  $("showRegisterBtn").onclick = () => showRegister();
  $("showLoginBtn").onclick = showLogin;
  $("forgotPasswordBtn").onclick = () => requestPasswordReset();
  $("registerBtn").onclick = registerWithPassword;
  $("registerHouse").onchange = updateLeaderPreview;
  $("saveNewPasswordBtn").onclick = () => saveNewPassword("newPassword", "confirmNewPassword");
  $("acceptLetterBtn").onclick = acceptLetter;
  $("closeLetter").onclick = () => $("letterModal").classList.add("hidden");
  $("logoutBtn").onclick = logout;
  $("openPasswordBtn").onclick = () => $("passwordDialog").showModal();
  $("closePasswordBtn").onclick = () => $("passwordDialog").close();
  $("saveAccountPasswordBtn").onclick = () => saveNewPassword("accountNewPassword", "accountConfirmPassword", true);
  await initSession();
}

init().catch(error => {
  console.error(error);
  toast("Ocurrio un error inesperado. Revisa la configuracion.");
});
