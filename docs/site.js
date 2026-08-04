/* HotClip 落地页动效 v3(GSAP 3.13,本地 vendor)——中英文页共用
   结构:切片装置 hero + pin 三幕 scrollytelling + 卡拉OK活演示 + bento */
(function () {
  if (typeof gsap === "undefined") return; // 脚本加载失败时页面保持静态可用

  gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, SplitText);
  gsap.defaults({ duration: 0.6, ease: "power2.out" });

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var $$ = function (s, root) { return gsap.utils.toArray((root || document).querySelectorAll(s)); };

  /* ---- 波形条生成(装饰,JS 生成保持 HTML 干净) ---- */
  function buildWave(el, n, hotRanges) {
    if (!el) return [];
    var bars = [];
    for (var i = 0; i < n; i++) {
      var b = document.createElement("i");
      var h = 22 + Math.abs(Math.sin(i * 1.7) + Math.sin(i * 0.53)) * 34; // 伪随机但确定
      b.style.height = h + "%";
      var pos = i / n;
      if (hotRanges && hotRanges.some(function (r) { return pos >= r[0] && pos <= r[1]; })) {
        b.className = "hot";
        b.style.height = Math.min(92, h + 34) + "%";
      }
      el.appendChild(b);
      bars.push(b);
    }
    return bars;
  }
  var filmBars = buildWave($("#film-wave"), 64, [[0.16, 0.25], [0.455, 0.545], [0.75, 0.84]]);
  buildWave($("#phone-wave"), 22, [[0.3, 0.55]]);

  /* ---- 逐字点亮循环(切片卡字幕 / 手机字幕 / 卡拉OK演示共用) ---- */
  function lightLoop(words, step, hold) {
    if (!words.length) return null;
    var tl = gsap.timeline({ repeat: -1, repeatDelay: 0.4 });
    words.forEach(function (w, i) {
      tl.call(function () { w.classList.add("lit"); }, null, i * step);
    });
    tl.to({}, { duration: words.length * step + (hold || 1.2) });
    tl.call(function () { words.forEach(function (w) { w.classList.remove("lit"); }); });
    return tl;
  }

  var mm = gsap.matchMedia();

  mm.add(
    {
      reduceMotion: "(prefers-reduced-motion: reduce)",
      isDesktop: "(min-width: 900px)"
    },
    function (context) {
      var reduceMotion = context.conditions.reduceMotion;
      var isDesktop = context.conditions.isDesktop;

      if (reduceMotion) {
        // 减弱动效:去掉预隐藏,所有动态数值直接写终值,不建任何动画
        document.documentElement.classList.remove("js");
        $$("[data-count]").forEach(function (el) { el.textContent = el.getAttribute("data-count"); });
        $$(".cc-num").forEach(function (el) { el.textContent = el.getAttribute("data-target"); });
        $$(".cc-bar i").forEach(function (el) { el.style.transform = "scaleX(" + (el.getAttribute("data-w") || 1) + ")"; });
        $$(".clip-cap .w, .ph-cap .w").forEach(function (w) { w.classList.add("lit"); });
        var kd = $("#karaoke-line");
        if (kd) kd.style.color = "var(--brand-2)";
        return;
      }

      /* ================= 首屏:文案 + 切片装置入场 ================= */
      var heroTl = gsap.timeline({ defaults: { duration: 0.7, ease: "power3.out" } });
      heroTl
        .from(".hero .eyebrow", { y: 24, autoAlpha: 0 })
        .from(".hero .sub", { y: 26, autoAlpha: 0 }, "-=0.4")
        .from(".hero .cta .btn", { y: 20, autoAlpha: 0, scale: 0.95, stagger: 0.1 }, "-=0.35")
        .from(".hero .note, .hero .meta-badges", { autoAlpha: 0, duration: 0.5 }, "-=0.25")
        // 装置:胶片划入 → 波形生长 → 切区点燃 → 成片卡切出升起
        .from(".rig .film", { y: 46, autoAlpha: 0, duration: 0.7 }, "-=0.2");
      if (filmBars.length) {
        heroTl.from(filmBars, { scaleY: 0, duration: 0.5, stagger: { each: 0.008, from: "start" }, ease: "power1.out" }, "-=0.3");
      }
      heroTl
        .from(".rig .cut", { scale: 0.6, autoAlpha: 0, stagger: 0.12, duration: 0.4, ease: "back.out(2)" }, "-=0.2")
        .from(".rig .flame", { scale: 0, autoAlpha: 0, stagger: 0.12, duration: 0.35, ease: "back.out(3)" }, "-=0.3")
        .from(".rig .clip-card", { y: 130, autoAlpha: 0, rotate: function (i) { return i === 1 ? 0 : (i === 0 ? -5 : 5); }, stagger: 0.14, duration: 0.85, ease: "power3.out" }, "-=0.15")
        .from(".rig .rig-label", { autoAlpha: 0, duration: 0.5 }, "-=0.3");

      // 装置待机动效:卡片漂浮 / 火苗闪烁 / 热区波形脉动
      $$(".rig .clip-card").forEach(function (card, i) {
        gsap.to(card, { y: i === 1 ? -10 : -6, duration: 2.2 + i * 0.35, yoyo: true, repeat: -1, ease: "sine.inOut", delay: 1.8 + i * 0.3 });
      });
      gsap.to(".rig .flame", { scale: 1.18, duration: 0.5, yoyo: true, repeat: -1, ease: "sine.inOut", stagger: 0.17, delay: 2 });
      filmBars.filter(function (b) { return b.className === "hot"; }).forEach(function (b, i) {
        gsap.to(b, { scaleY: 0.55, duration: 0.42 + (i % 5) * 0.06, yoyo: true, repeat: -1, ease: "sine.inOut", delay: 2 });
      });
      // 三张卡的字幕逐字点亮循环
      $$(".rig .clip-card").forEach(function (card, i) {
        var loop = lightLoop($$(".clip-cap .w", card), 0.5, 1.4);
        if (loop) loop.delay(2 + i * 0.6);
      });

      /* ---- H1 逐字入场(等字体就绪,避免断行错位) ---- */
      document.fonts.ready.then(function () {
        var title = $("#hero-title");
        if (!title) return;
        SplitText.create(title, {
          type: "chars",
          autoSplit: true,
          onSplit: function (self) {
            return gsap.from(self.chars, { y: 26, autoAlpha: 0, stagger: 0.022, duration: 0.55, ease: "power3.out" });
          }
        });
      });

      /* ================= 三幕 scrollytelling ================= */
      var stageWrap = $(".scrolly .stage-wrap");
      if (stageWrap && isDesktop) {
        stageWrap.classList.add("js-pin");
        var sps = $$(".stage-progress .sp");
        var setActive = function (idx) {
          sps.forEach(function (sp, i) { sp.classList.toggle("active", i === idx); });
        };
        gsap.set(".stage-2, .stage-3", { autoAlpha: 0 });

        var ccProxy = { val: 0 };
        var ccNum = $(".stage-2 .cc-num");
        var ccTarget = ccNum ? parseInt(ccNum.getAttribute("data-target"), 10) : 92;

        var pinTl = gsap.timeline({
          scrollTrigger: {
            trigger: stageWrap,
            start: "top 12%",
            end: "+=2400",
            pin: true,
            scrub: 0.6,
            onUpdate: function (self) {
              setActive(self.progress < 0.3 ? 0 : (self.progress < 0.66 ? 1 : 2));
            }
          },
          defaults: { ease: "power2.out" }
        });

        pinTl
          // 幕1:文件飞入托盘
          .from(".stage-1 .file-chip", { x: function (i) { return [-120, 140, -90][i]; }, y: function (i) { return [-80, -60, 90][i]; }, autoAlpha: 0, stagger: 0.15, duration: 0.8 })
          .to(".stage-1 .file-chip", { x: 0, y: 0, scale: 0.92, duration: 0.6 })
          .to({}, { duration: 0.4 })
          // 幕1 → 幕2
          .to(".stage-1", { autoAlpha: 0, y: -30, duration: 0.5 })
          .to(".stage-2", { autoAlpha: 1, duration: 0.5 }, "<0.2")
          .from(".stage-2 .cand-card", { y: 60, duration: 0.6 }, "<")
          .fromTo(".stage-2 .cc-dims .cc-bar i", { scaleX: 0 }, {
            scaleX: function (i, el) { return parseFloat(el.getAttribute("data-w") || 1); },
            stagger: 0.1, duration: 0.5
          }, "<0.3")
          .to(ccProxy, {
            val: ccTarget, duration: 0.8,
            onUpdate: function () { if (ccNum) ccNum.textContent = Math.round(ccProxy.val); }
          }, "<")
          .from(".stage-2 .cand-mini", { y: 30, autoAlpha: 0, duration: 0.5 }, "<0.4")
          .to({}, { duration: 0.5 })
          // 幕2 → 幕3
          .to(".stage-2", { autoAlpha: 0, y: -30, duration: 0.5 })
          .to(".stage-3", { autoAlpha: 1, duration: 0.5 }, "<0.2")
          .from(".stage-3 .phone", { y: 90, rotate: -4, duration: 0.7 }, "<")
          .from(".stage-3 .export-item", { x: -40, autoAlpha: 0, stagger: 0.12, duration: 0.45 }, "<0.3")
          .to({}, { duration: 0.6 });
      } else if (stageWrap) {
        // 移动端/窄屏:不 pin,三幕纵向排列滚动进场
        $$(".scrolly .stage").forEach(function (st) {
          gsap.from(st, {
            autoAlpha: 0, y: 50, duration: 0.7,
            scrollTrigger: { trigger: st, start: "top 82%", once: true }
          });
        });
        var ccNumM = $(".stage-2 .cc-num");
        if (ccNumM) {
          var proxyM = { val: 0 };
          gsap.to(proxyM, {
            val: parseInt(ccNumM.getAttribute("data-target"), 10), duration: 1.2,
            scrollTrigger: { trigger: ccNumM, start: "top 85%", once: true },
            onUpdate: function () { ccNumM.textContent = Math.round(proxyM.val); }
          });
        }
        $$(".stage-2 .cc-bar i").forEach(function (bar) {
          gsap.fromTo(bar, { scaleX: 0 }, {
            scaleX: parseFloat(bar.getAttribute("data-w") || 1), duration: 0.8,
            scrollTrigger: { trigger: bar, start: "top 90%", once: true }
          });
        });
        $(".stage-progress") && ($(".stage-progress").style.display = "none");
      }
      // 手机字幕逐字点亮(两种模式都跑)
      lightLoop($$(".stage-3 .ph-cap .w"), 0.55, 1.5);

      /* ================= 卡拉OK活演示 ================= */
      var kdLine = $("#karaoke-line");
      if (kdLine) {
        document.fonts.ready.then(function () {
          SplitText.create(kdLine, {
            type: "chars",
            autoSplit: true,
            aria: "hidden", /* p 元素禁用 aria-label,演示行的语义由外层 region 提供 */
            onSplit: function (self) {
              var tl = gsap.timeline({ repeat: -1, repeatDelay: 0.9, scrollTrigger: { trigger: kdLine, start: "top 88%" } });
              self.chars.forEach(function (c, i) {
                tl.call(function () { c.classList.add("lit"); }, null, i * 0.09);
              });
              tl.to({}, { duration: self.chars.length * 0.09 + 1.4 });
              tl.call(function () { self.chars.forEach(function (c) { c.classList.remove("lit"); }); });
              return tl;
            }
          });
        });
      }

      /* ================= 通用滚动进场 ================= */
      gsap.set("[data-reveal]", { autoAlpha: 0, y: 40 });
      ScrollTrigger.batch("[data-reveal]", {
        start: "top 85%",
        once: true,
        onEnter: function (items) {
          gsap.to(items, { autoAlpha: 1, y: 0, stagger: 0.1, duration: 0.6, overwrite: true });
        }
      });

      /* ---- bento 里的 mini 候选卡:进场时条形生长 ---- */
      $$(".b-hotspot .cc-bar i").forEach(function (bar) {
        gsap.fromTo(bar, { scaleX: 0 }, {
          scaleX: parseFloat(bar.getAttribute("data-w") || 1), duration: 0.9, ease: "power2.out",
          scrollTrigger: { trigger: bar, start: "top 88%", once: true }
        });
      });
      /* ---- 数字滚动计数 ---- */
      $$("[data-count]").forEach(function (el) {
        var target = parseFloat(el.getAttribute("data-count"));
        var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
        var proxy = { val: 0 };
        gsap.to(proxy, {
          val: target, duration: 1.2, ease: "power1.out",
          scrollTrigger: { trigger: el, start: "top 90%", once: true },
          onUpdate: function () { el.textContent = proxy.val.toFixed(decimals); }
        });
      });

      /* ---- 对比表逐行点亮 ---- */
      var rows = $$("#compare-table tbody tr");
      if (rows.length) {
        gsap.set(rows, { autoAlpha: 0, x: -24 });
        gsap.to(rows, {
          autoAlpha: 1, x: 0, stagger: 0.1, duration: 0.5,
          scrollTrigger: { trigger: "#compare-table", start: "top 80%", once: true }
        });
      }

      /* ---- 背景光晕视差 + 顶部进度条 ---- */
      $$(".glow").forEach(function (glow, i) {
        gsap.to(glow, {
          yPercent: i % 2 ? -28 : 22, ease: "none",
          scrollTrigger: { trigger: document.body, start: "top top", end: "max", scrub: 1 }
        });
      });
      gsap.to(".progress", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });

      /* ---- 平台跑马灯 ---- */
      var track = $(".marquee-track");
      if (track && !track.dataset.cloned) {
        track.dataset.cloned = "1";
        track.innerHTML += track.innerHTML.replace(/<span class="p"/g, '<span aria-hidden="true" class="p"');
        var marquee = gsap.to(track, { xPercent: -50, ease: "none", duration: 26, repeat: -1 });
        track.parentElement.addEventListener("mouseenter", function () { marquee.pause(); });
        track.parentElement.addEventListener("mouseleave", function () { marquee.play(); });
      }

      /* ---- FAQ 展开小动效 ---- */
      $$("#faq details").forEach(function (d) {
        d.addEventListener("toggle", function () {
          if (d.open) gsap.from(d.querySelectorAll("p"), { autoAlpha: 0, y: -8, duration: 0.35 });
        });
      });

      return function () { if (stageWrap) stageWrap.classList.remove("js-pin"); };
    }
  );

  /* ---- 导航锚点平滑滚动(CSS 未设 scroll-behavior,避免打架) ---- */
  var NAV_OFFSET = 68;
  document.querySelectorAll('nav a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      gsap.to(window, { duration: 0.8, ease: "power2.inOut", scrollTo: { y: target, offsetY: NAV_OFFSET } });
    });
  });

  /* ---- 顶栏滚动后加分隔线 ---- */
  var nav = document.getElementById("sitenav");
  if (nav) {
    ScrollTrigger.create({
      start: 10,
      onEnter: function () { nav.classList.add("scrolled"); },
      onLeaveBack: function () { nav.classList.remove("scrolled"); }
    });
  }

  /* ---- 图片全部加载后重算触发位置 ---- */
  window.addEventListener("load", function () { ScrollTrigger.refresh(); });

  /* ---- GitHub 星数/版本号(失败静默,保留静态兜底) ---- */
  function fmtStars(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
  }
  fetch("https://api.github.com/repos/xixihhhh/hotclip")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || typeof data.stargazers_count !== "number") return;
      var el = document.getElementById("gh-stars");
      if (el) el.textContent = "★ " + fmtStars(data.stargazers_count);
      var navEl = document.getElementById("gh-stars-nav");
      if (navEl) navEl.textContent = " ★" + fmtStars(data.stargazers_count);
    })
    .catch(function () {});
  fetch("https://api.github.com/repos/xixihhhh/hotclip/releases/latest")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.tag_name) return;
      var el = document.getElementById("gh-version");
      if (el) el.textContent = data.tag_name;
    })
    .catch(function () {});
})();
