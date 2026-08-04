/* HotClip 落地页动效(GSAP 3.13,本地 vendor 加载)——中英文页共用 */
(function () {
  if (typeof gsap === "undefined") return; // 脚本没加载成功时页面保持静态可用

  gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, SplitText);
  gsap.defaults({ duration: 0.6, ease: "power2.out" });

  var mm = gsap.matchMedia();

  mm.add(
    {
      reduceMotion: "(prefers-reduced-motion: reduce)",
      isDesktop: "(min-width: 800px)"
    },
    function (context) {
      var reduceMotion = context.conditions.reduceMotion;

      if (reduceMotion) {
        // 减弱动效:去掉 .js 预隐藏,数字直接写终值,不建任何动画
        document.documentElement.classList.remove("js");
        document.querySelectorAll("[data-count]").forEach(function (el) {
          el.textContent = el.getAttribute("data-count");
        });
        return;
      }

      /* ---- 首屏入场时间线(from() 即建即渲染,防闪烁) ---- */
      var heroTl = gsap.timeline({ defaults: { duration: 0.7, ease: "power3.out" } });
      heroTl
        .from(".hero .eyebrow", { y: 24, autoAlpha: 0 })
        .from(".hero .sub", { y: 30, autoAlpha: 0 }, "-=0.35")
        .from(".hero .chips .chip", { y: 16, autoAlpha: 0, stagger: 0.07, duration: 0.45 }, "-=0.4")
        .from(".hero .cta .btn", { y: 20, autoAlpha: 0, scale: 0.95, stagger: 0.1 }, "-=0.25")
        .from(".hero .note, .hero .meta-badges", { autoAlpha: 0, duration: 0.5 }, "-=0.2")
        .from(".hero .shot", { y: 60, autoAlpha: 0, scale: 0.965, duration: 0.9 }, "-=0.35");

      /* ---- H1 逐字点亮(等字体就绪再切分,避免断行错位) ---- */
      document.fonts.ready.then(function () {
        var title = document.getElementById("hero-title");
        if (!title) return;
        SplitText.create(title, {
          type: "chars",
          autoSplit: true,
          onSplit: function (self) {
            return gsap.from(self.chars, {
              y: 26,
              autoAlpha: 0,
              stagger: 0.022,
              duration: 0.55,
              ease: "power3.out"
            });
          }
        });
      });

      /* ---- 滚动进场:所有 data-reveal 元素批量 reveal ---- */
      gsap.set("[data-reveal]", { autoAlpha: 0, y: 40 });
      ScrollTrigger.batch("[data-reveal]", {
        start: "top 85%",
        once: true,
        onEnter: function (items) {
          gsap.to(items, { autoAlpha: 1, y: 0, stagger: 0.1, duration: 0.6, overwrite: true });
        }
      });

      /* ---- 数字滚动计数 ---- */
      gsap.utils.toArray("[data-count]").forEach(function (el) {
        var target = parseFloat(el.getAttribute("data-count"));
        var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
        var proxy = { val: 0 };
        gsap.to(proxy, {
          val: target,
          duration: 1.2,
          ease: "power1.out",
          scrollTrigger: { trigger: el, start: "top 90%", once: true },
          onUpdate: function () {
            el.textContent = proxy.val.toFixed(decimals);
          }
        });
      });

      /* ---- 对比表逐行点亮 ---- */
      var rows = gsap.utils.toArray("#compare-table tbody tr");
      if (rows.length) {
        gsap.set(rows, { autoAlpha: 0, x: -24 });
        gsap.to(rows, {
          autoAlpha: 1,
          x: 0,
          stagger: 0.1,
          duration: 0.5,
          scrollTrigger: { trigger: "#compare-table", start: "top 80%", once: true }
        });
      }

      /* ---- 背景光晕随滚动视差(scrub 必须线性) ---- */
      gsap.utils.toArray(".glow").forEach(function (glow, i) {
        gsap.to(glow, {
          yPercent: i % 2 ? -28 : 22,
          ease: "none",
          scrollTrigger: { trigger: document.body, start: "top top", end: "max", scrub: 1 }
        });
      });

      /* ---- 顶部滚动进度条 ---- */
      gsap.to(".progress", {
        scaleX: 1,
        ease: "none",
        scrollTrigger: { start: 0, end: "max", scrub: 0.3 }
      });

      /* ---- 平台跑马灯(复制一份轨道内容做无缝循环) ---- */
      var track = document.querySelector(".marquee-track");
      if (track && !track.dataset.cloned) {
        track.dataset.cloned = "1";
        track.innerHTML += track.innerHTML.replace(/<span class="p"/g, '<span aria-hidden="true" class="p"');
        var marquee = gsap.to(track, { xPercent: -50, ease: "none", duration: 26, repeat: -1 });
        track.parentElement.addEventListener("mouseenter", function () { marquee.pause(); });
        track.parentElement.addEventListener("mouseleave", function () { marquee.play(); });
      }

      /* ---- FAQ 展开小动效 ---- */
      document.querySelectorAll("#faq details").forEach(function (d) {
        d.addEventListener("toggle", function () {
          if (d.open) {
            var p = d.querySelectorAll("p");
            gsap.from(p, { autoAlpha: 0, y: -8, duration: 0.35 });
          }
        });
      });
    }
  );

  /* ---- 导航锚点平滑滚动(与 CSS scroll-behavior 二选一,CSS 侧未设) ---- */
  var NAV_OFFSET = 68;
  document.querySelectorAll('nav a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      gsap.to(window, {
        duration: 0.8,
        ease: "power2.inOut",
        scrollTo: { y: target, offsetY: NAV_OFFSET }
      });
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

  /* ---- GitHub 星数/版本号(失败静默,保留静态兜底文案) ---- */
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
