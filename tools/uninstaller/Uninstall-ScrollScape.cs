// Desinstalador do ScrollScape: remove a instalação sem deixar fragmentos.
//
// Compilar: tools\build-uninstaller.bat  (usa o csc.exe que já vem com o Windows).
// Usar:     colocar uninstall.exe na pasta do .exe do ScrollScape e abri-lo.
//
//   uninstall.exe              não pergunta nada: apaga tudo (sem cópia de segurança; quem a quiser faz-a antes)
//   uninstall.exe --ask        pergunta antes de apagar e antes de cada extra (cópia da biblioteca, ficheiros de manga, firewall, ...)
//   uninstall.exe --dry-run    só mostra o que apagaria
//   uninstall.exe --yes        não pergunta e só apaga o essencial (não mexe em firewall/tailscale/cache partilhada)
//
// SEGURANÇA: nunca apaga "a pasta onde está". Só apaga uma lista fechada de
// nomes conhecidos (data, Local, tools\flaresolverr, ScrollScape*.exe, ...),
// cada um confirmado como sendo do ScrollScape, e só remove a pasta no fim se
// ficar vazia e não for Ambiente de trabalho / Transferências / Documentos / etc.
// Ligações (junctions/symlinks) são removidas como ligações: o destino não é tocado.
// Não deixa ficheiros de registo.
//
// Códigos de saída: 0 ok, 1 cancelado, 2 concluído com avisos, 3 recusado.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Text;
using System.Threading;

static class Program
{
    const string AppExeLike = "ScrollScape";
    static readonly string[] LauncherFiles =
    {
        "Start-ScrollScape-Safe.ps1", "Abrir-ScrollScape-Seguro.bat", "Launch-ScrollScape.bat"
    };
    static readonly StringComparison Ic = StringComparison.OrdinalIgnoreCase;

    static bool anyDeleted;
    static bool dryRun, yes, ask, auto, worker, skipFirewall, skipTailscale;
    static int testDelayMs; // so para testes: atrasa o fim, como um utilizador que demora a carregar numa tecla
    static string workerDir, parentExe;
    static readonly List<string> extraProtect = new List<string>();
    static readonly List<string> extraShortcutDirs = new List<string>();
    static readonly List<string> problems = new List<string>();
    static readonly List<string> left = new List<string>();

    class Plan
    {
        public string InstallDir;
        public List<string> Dirs = new List<string>();      // apagar (recursivo, sem seguir ligações)
        public List<string> Files = new List<string>();
        public List<string> LocalDirs = new List<string>();   // biblioteca local do utilizador: pergunta propria, "nao" por defeito
        public List<string> EmptyIfDone = new List<string>(); // remover só se ficarem vazias
        public List<string> Shortcuts = new List<string>();
        public List<KeyValuePair<int, string>> Processes = new List<KeyValuePair<int, string>>();
        public Dictionary<int, string> ProcessPaths = new Dictionary<int, string>();
        public List<string> FirewallRules = new List<string>();
        public List<string> FirewallDescriptions = new List<string>();
        public bool FlareSolverrFound;
        public string TailscaleNote;
        public string LibraryFile;                          // store.json a copiar (opcional)
        public List<string> Misc = new List<string>();       // restos conhecidos fora da pasta
        public string ChromedriverCache;
    }

    static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception e)
        {
            // Nunca deixar o diálogo de erro do Windows: mensagem clara e código 2.
            Console.Error.WriteLine("Erro inesperado: " + e.Message);
            return 2;
        }
    }

    static int Run(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--dry-run": dryRun = true; break;
                case "--yes": yes = true; break;
                case "--ask": ask = true; break;
                case "--skip-firewall": skipFirewall = true; break;   // não lista nem remove regras do Firewall
                case "--skip-tailscale": skipTailscale = true; break; // não olha para o tailscale serve
                case "--test-delay": int.TryParse(NextArg(args, ref i), out testDelayMs); break;
                case "--worker": worker = true; workerDir = NextArg(args, ref i); break;
                case "--parent": parentExe = NextArg(args, ref i); break;
                case "--protect": extraProtect.Add(NextArg(args, ref i)); break;          // só acrescenta proteção (usado em testes)
                case "--shortcut-dir": extraShortcutDirs.Add(NextArg(args, ref i)); break; // só acrescenta pastas a verificar
                case "--help": case "-h": case "/?": Help(); return 0;
                default: Console.Error.WriteLine("Opção desconhecida: " + args[i]); Help(); return 3;
            }
        }

        auto = !ask && !yes; // por defeito não pergunta nada e apaga tudo
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string installDir = worker ? workerDir : Path.GetDirectoryName(self);

        // O processo "pai" só lança o worker (que é quem fala com o utilizador): não repete o cabeçalho.
        bool silentParent = !worker && !dryRun;
        string refusal = Refuse(installDir);
        if (!silentParent || refusal != null)
        {
            Console.WriteLine("ScrollScape - Desinstalador");
            Console.WriteLine("Pasta: " + installDir);
            Console.WriteLine();
        }
        if (refusal != null) { Console.WriteLine("RECUSADO: " + refusal); return Pause(3); }

        // O .exe em execução não se pode apagar a si próprio: o pai só lança uma cópia a partir de %TEMP% (o worker) e espera.
        if (!worker && !dryRun)
        {
            string tmp = Path.Combine(Path.GetTempPath(), "ScrollScape-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(self, tmp, true);
            var psi = new ProcessStartInfo(tmp, "--worker " + Q(installDir) + " --parent " + Q(self)
                + (yes ? " --yes" : "") + (ask ? " --ask" : "") + (skipFirewall ? " --skip-firewall" : "") + (skipTailscale ? " --skip-tailscale" : "") + (testDelayMs > 0 ? " --test-delay " + testDelayMs : "")
                + string.Join("", extraProtect.Select(p => " --protect " + Q(p)).ToArray())
                + string.Join("", extraShortcutDirs.Select(p => " --shortcut-dir " + Q(p)).ToArray()))
            { UseShellExecute = false };
            // Numa consola normal (duplo clique) o worker partilha-a. Com entrada/saída redirecionadas (script, teste)
            // não se confia na herança dos handles: o pai encaminha explicitamente a entrada, a saída e os erros.
            bool piped = Console.IsInputRedirected || Console.IsOutputRedirected || Console.IsErrorRedirected;
            if (piped)
            {
                psi.RedirectStandardInput = true; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
            }
            int workerCode;
            using (var p = Process.Start(psi))
            {
                if (!piped) { p.WaitForExit(); workerCode = p.ExitCode; }
                else
                {
                    var outPump = new Thread(() => Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput())) { IsBackground = true };
                    var errPump = new Thread(() => Pump(p.StandardError.BaseStream, Console.OpenStandardError())) { IsBackground = true };
                    var inPump = new Thread(() =>
                    {
                        try { using (var input = Console.OpenStandardInput()) Pump(input, p.StandardInput.BaseStream); } catch { }
                        try { p.StandardInput.Close(); } catch { }
                    }) { IsBackground = true };
                    outPump.Start(); errPump.Start(); inPump.Start();
                    p.WaitForExit();
                    outPump.Join(3000); errPump.Join(3000);
                    workerCode = p.ExitCode;
                }
            }
            // O worker já terminou: a cópia temporária de si próprio não pode ficar em %TEMP% (cancelou, recusou ou falhou).
            // Quando o worker apagou instalação, o cmd agendado por ele trata do ficheiro; apagar aqui é inofensivo se já foi.
            for (int i = 0; i < 6 && File.Exists(tmp); i++)
            {
                try { File.Delete(tmp); } catch { Thread.Sleep(150); }
            }
            return workerCode;
        }

        Console.WriteLine("A analisar o que existe no computador (pode demorar uns segundos)...");
        Plan plan = Build(installDir, self);
        if (plan.Dirs.Count + plan.LocalDirs.Count + plan.Files.Count + plan.Processes.Count + plan.Shortcuts.Count + plan.Misc.Count == 0
            && plan.FirewallRules.Count == 0)
        {
            Console.WriteLine("Não encontrei nada do ScrollScape para remover aqui.");
            return Pause(0);
        }
        Show(plan);
        if (dryRun) { Console.WriteLine("(--dry-run: nada foi apagado)"); return 0; }

        if (!yes && !auto && !Ask("Apagar tudo o que está listado acima?", false)) { Console.WriteLine("Cancelado. Nada foi apagado."); return Pause(1); }

        // 1) fechar processos
        foreach (var pr in plan.Processes) KillProcess(pr.Key, pr.Value, plan.ProcessPaths.ContainsKey(pr.Key) ? plan.ProcessPaths[pr.Key] : null);
        Thread.Sleep(800);

        // 2) cópia da biblioteca (opcional). Se o utilizador a pediu e falhar, NADA é apagado.
        if (plan.LibraryFile != null && !yes && !auto
            && Ask("Guardar uma cópia da sua biblioteca (favoritos, histórico, críticas e as fontes que instalou) em Documentos antes de apagar?", false))
        {
            try
            {
                string docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                string dest = Path.Combine(docs, "ScrollScape-copia-" + DateTime.Now.ToString("yyyy-MM-dd-HHmm"));
                Directory.CreateDirectory(dest);
                File.Copy(plan.LibraryFile, Path.Combine(dest, "store.json"), false);
                string srcSources = Path.Combine(Path.GetDirectoryName(plan.LibraryFile), "sources");
                if (Directory.Exists(srcSources) && !Reparse(srcSources)) CopyTree(srcSources, Path.Combine(dest, "sources"));
                Console.WriteLine("  Guardada em " + dest);
                left.Add(dest + "  (a sua cópia da biblioteca e das fontes, de propósito)");
            }
            catch (Exception e)
            {
                Console.WriteLine("A cópia da biblioteca falhou (" + e.Message + "). Para não perder nada, NÃO apaguei nada.");
                return Pause(2);
            }
        }

        // 3) apagar
        foreach (var d in plan.Dirs) Remove(d, true);
        foreach (var f in plan.Files) Remove(f, false);
        foreach (var s in plan.Shortcuts) Remove(s, false);
        foreach (var m in plan.Misc) Remove(m, Directory.Exists(m));
        foreach (var l in plan.LocalDirs)
        {
            if (!yes && Ask("A pasta " + l + " tem os seus ficheiros de manga importados (" + SizeText(l) + "). Apagar TAMBÉM esses ficheiros?", false)) Remove(l, true);
            else left.Add(l + "  (os seus ficheiros de manga; não lhes toquei)");
        }

        // 4) extras que precisam de consentimento explícito
        if (plan.ChromedriverCache != null && !yes
            && Ask("Apagar também a cache do FlareSolverr em " + plan.ChromedriverCache
                   + " (partilhada com outros programas que usem 'undetected_chromedriver')?", false))
            Remove(plan.ChromedriverCache, true);
        if (plan.FirewallRules.Count > 0 && !yes
            && Ask("Remover " + plan.FirewallRules.Count + " regra(s) do Firewall do Windows deste programa? (pede permissão de administrador)", false))
            RemoveFirewall(plan);
        if (plan.TailscaleNote != null && auto)
            left.Add("Tailscale: " + plan.TailscaleNote + "  (o 'tailscale serve reset' apaga TODA a configuração serve, por isso não o faço sozinho; use '--ask' ou corra-o à mão)");
        else if (plan.TailscaleNote != null && !yes
            && Ask("O Tailscale está a publicar o ScrollScape (" + plan.TailscaleNote + "). Desligar com 'tailscale serve reset'? (limpa TODA a configuração serve)", false))
            RunQuiet(TailscaleExe(), "serve reset");

        // 5) pastas que ficam vazias
        foreach (var e in plan.EmptyIfDone) RemoveIfEmpty(e);

        Report(plan);
        ScheduleSelfDelete(installDir);
        if (testDelayMs > 0) Thread.Sleep(testDelayMs);
        return Pause(problems.Count == 0 ? 0 : 2);
    }

    // ------------------------------------------------------------------ segurança

    static string Refuse(string dir)
    {
        if (!Directory.Exists(dir)) return "a pasta não existe.";
        if (File.Exists(Path.Combine(dir, "package.json")) && File.Exists(Path.Combine(dir, "server.js")))
            return "esta é a pasta do código-fonte do projeto, não uma instalação. Não apago código.";
        string up = dir;
        for (int level = 0; up != null && level < 4; level++, up = Path.GetDirectoryName(up))
        {
            // .git pode ser pasta (repositório) ou ficheiro (worktree/submódulo)
            if (Directory.Exists(Path.Combine(up, ".git")) || File.Exists(Path.Combine(up, ".git")))
                return "esta pasta está dentro de um repositório git (" + up + "). Não apago repositórios.";
            if (File.Exists(Path.Combine(up, "package.json")) && File.Exists(Path.Combine(up, "server.js")))
                return "esta pasta está dentro do código-fonte do projeto (" + up + "), não é uma instalação.";
        }
        return null;
    }

    static List<string> ProtectedDirs()
    {
        var l = new List<string>();
        Action<string> add = p => { if (!string.IsNullOrWhiteSpace(p)) { try { l.Add(Norm(p)); } catch { } } };
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        add(profile);
        add(Environment.GetFolderPath(Environment.SpecialFolder.Desktop));
        add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        add(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
        add(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures));
        add(Environment.GetFolderPath(Environment.SpecialFolder.MyMusic));
        add(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos));
        add(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
        add(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        add(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        add(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
        add(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        add(Environment.GetFolderPath(Environment.SpecialFolder.System));
        add(Path.GetTempPath());
        if (!string.IsNullOrEmpty(profile))
        {
            add(Path.Combine(profile, "Downloads"));
            add(Path.Combine(profile, "OneDrive"));
        }
        add(Environment.GetEnvironmentVariable("OneDrive"));
        add(Environment.GetEnvironmentVariable("OneDriveConsumer"));
        add(Environment.GetEnvironmentVariable("OneDriveCommercial"));
        add(Environment.GetEnvironmentVariable("PUBLIC"));
        add(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
        add(Environment.GetFolderPath(Environment.SpecialFolder.CommonDocuments));
        add(KnownFolder(new Guid("374DE290-123F-4565-9164-39C4925E467B"))); // Transferências, mesmo que tenha sido movida
        add(Path.GetDirectoryName(profile ?? ""));                           // C:\Users
        foreach (var p in extraProtect) add(p);
        return l;
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    static extern int SHGetKnownFolderPath([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPStruct)] Guid rfid,
        uint dwFlags, IntPtr hToken, out IntPtr ppszPath);

    static string KnownFolder(Guid id)
    {
        try
        {
            IntPtr p;
            if (SHGetKnownFolderPath(id, 0, IntPtr.Zero, out p) != 0) return null;
            string s = System.Runtime.InteropServices.Marshal.PtrToStringUni(p);
            System.Runtime.InteropServices.Marshal.FreeCoTaskMem(p);
            return s;
        }
        catch { return null; }
    }

    static bool IsProtectedDir(string dir)
    {
        string n;
        try { n = Norm(dir); } catch { return true; }
        if (Path.GetPathRoot(n) != null && string.Equals(Path.GetPathRoot(n).TrimEnd('\\'), n, Ic)) return true; // raiz de unidade
        return ProtectedDirs().Any(p => string.Equals(p, n, Ic));
    }

    // ------------------------------------------------------------------ plano

    static Plan Build(string installDir, string self)
    {
        var plan = new Plan { InstallDir = installDir };
        var roots = new List<string> { installDir };
        string sub = Path.Combine(installDir, "ScrollScape");
        // As pastas extra passam pelas mesmas recusas que a pasta do desinstalador (código-fonte, repositório git).
        if (Directory.Exists(sub) && !Reparse(sub) && Refuse(sub) == null) roots.Add(sub);
        string home = EnvAny("SCROLLSCAPE_HOME");
        if (!string.IsNullOrWhiteSpace(home) && Directory.Exists(home) && !IsProtectedDir(home) && Refuse(home) == null
            && !roots.Any(r => string.Equals(Norm(r), Norm(home), Ic)))
        {
            // O dono tem de ter apontado isto de propósito: mostra-se com destaque no resumo.
            roots.Add(home);
        }

        foreach (var r in roots)
        {
            string data = Path.Combine(r, "data");
            // "data" só é nossa se o store.json for mesmo o do ScrollScape (tem installedSources e repos),
            // ou se existir o ficheiro de bloqueio do app, ou o setup.json com a escolha do FlareSolverr.
            bool marker = IsScrollScapeStore(Path.Combine(data, "store.json"))
                          || File.Exists(Path.Combine(data, ".scrollscape.lock"))
                          || SetupLooksOurs(Path.Combine(data, "setup.json"))
                          || PartialInstallData(r, data);
            bool toolsOk = Directory.Exists(Path.Combine(r, "tools")) && !Reparse(Path.Combine(r, "tools"));
            bool ownsRoot = marker;
            if (!ownsRoot) { try { ownsRoot = Directory.GetFiles(r, "ScrollScape*.exe").Any(IsAppExe); } catch { } }
            if (marker)
            {
                AddDir(plan, data);
                string local = Path.Combine(r, "Local");
                if (Directory.Exists(local) && !Reparse(local))
                {
                    if (Directory.EnumerateFileSystemEntries(local).Any()) plan.LocalDirs.Add(local); else AddDir(plan, local);
                }
                if (plan.LibraryFile == null && File.Exists(Path.Combine(data, "store.json"))) plan.LibraryFile = Path.Combine(data, "store.json");
            }
            if (toolsOk && ownsRoot)
            {
                string fs = Path.Combine(r, "tools", "flaresolverr");
                if (File.Exists(Path.Combine(fs, "flaresolverr.exe")) && !Reparse(fs)) { AddDir(plan, fs); plan.FlareSolverrFound = true; }
                string dash = Path.Combine(r, "tools", "dashboard");
                if (File.Exists(Path.Combine(dash, "dashboard.py")) && !Reparse(dash)) AddDir(plan, dash);
                plan.EmptyIfDone.Add(Path.Combine(r, "tools"));
            }
            if (!string.Equals(Norm(r), Norm(installDir), Ic) && string.Equals(Path.GetFileName(Norm(r)), "ScrollScape", Ic))
                plan.EmptyIfDone.Add(r);
        }

        // ficheiros do programa na pasta do desinstalador
        string selfFull = Norm(self);
        foreach (var f in Directory.GetFiles(installDir))
        {
            string name = Path.GetFileName(f);
            bool app = IsAppExe(f);
            bool launcher = LauncherFiles.Any(l => string.Equals(l, name, Ic));
            if ((app || launcher) && !string.Equals(Norm(f), selfFull, Ic) && !Reparse(f)
                && (string.IsNullOrEmpty(parentExe) || !string.Equals(Norm(f), Norm(parentExe), Ic))) plan.Files.Add(f);
        }
        // o próprio desinstalador (e a cópia em curso) são apagados no fim, por fora
        if (!worker) { /* já não aparece como item: é tratado por ScheduleSelfDelete */ }
        plan.EmptyIfDone.Add(installDir);

        Console.WriteLine("  a ver os programas em execução...");
        FindProcesses(plan, roots, selfFull);
        Console.WriteLine("  a procurar atalhos...");
        FindShortcuts(plan);
        if (!skipFirewall) { Console.WriteLine("  a ler as regras do Firewall..."); FindFirewall(plan); }
        if (!skipTailscale) { Console.WriteLine("  a verificar o Tailscale..."); FindTailscale(plan); }

        string appdata = Environment.GetEnvironmentVariable("APPDATA");
        if (plan.FlareSolverrFound && !string.IsNullOrEmpty(appdata))
        {
            string cache = Path.Combine(appdata, "undetected_chromedriver");
            if (Directory.Exists(cache) && !Reparse(cache)) plan.ChromedriverCache = cache;
        }
        string localApp = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (!string.IsNullOrEmpty(localApp))
        {
            string l = Path.Combine(localApp, "ScrollScape");
            if (Directory.Exists(l) && !Reparse(l)) plan.Misc.Add(l);
        }
        string fsPid = Path.Combine(Path.GetTempPath(), "fs_pid.txt");
        if (File.Exists(fsPid)) plan.Misc.Add(fsPid);
        return plan;
    }

    static void AddDir(Plan plan, string dir)
    {
        if (!Directory.Exists(dir)) return;
        if (plan.Dirs.Any(d => string.Equals(Norm(d), Norm(dir), Ic))) return;
        plan.Dirs.Add(dir);
    }

    static void FindProcesses(Plan plan, List<string> roots, string selfFull)
    {
        int me = Process.GetCurrentProcess().Id;
        try
        {
            using (var s = new ManagementObjectSearcher("SELECT ProcessId, Name, ExecutablePath FROM Win32_Process"))
            foreach (ManagementObject o in s.Get())
            {
                try
                {
                string path = o["ExecutablePath"] as string;
                string name = o["Name"] as string ?? "";
                if (string.IsNullOrEmpty(path)) continue;
                int pid = Convert.ToInt32(o["ProcessId"]);
                if (pid == me || string.Equals(Norm(path), selfFull, Ic)) continue;
                if (!string.IsNullOrEmpty(parentExe) && string.Equals(Norm(path), Norm(parentExe), Ic)) continue;
                bool inRoot = roots.Any(r => IsUnder(path, r));
                bool ours = name.StartsWith(AppExeLike, Ic) && name.EndsWith(".exe", Ic) && inRoot;
                bool fsTool = (name.Equals("flaresolverr.exe", Ic) || name.Equals("chrome.exe", Ic) || name.Equals("chromedriver.exe", Ic))
                              && roots.Any(r => IsUnder(path, Path.Combine(r, "tools", "flaresolverr")));
                if (ours || fsTool) { plan.Processes.Add(new KeyValuePair<int, string>(pid, name + "  (" + path + ")")); plan.ProcessPaths[pid] = path; }
                }
                catch (Exception) { /* um processo com caminho ilegível não pode impedir os restantes */ }
            }
        }
        catch (Exception e) { problems.Add("Não consegui listar processos: " + e.Message); }
    }

    // O ficheiro .lnk guarda o destino em texto (ANSI e UTF-16): procura-se sem o abrir com o Windows.
    static bool ShortcutMentions(string lnkFile, List<string> needles)
    {
        try
        {
            var fi = new FileInfo(lnkFile);
            if (fi.Length > 1024 * 1024) return true; // estranho: resolve-se a sério, por segurança
            byte[] b = File.ReadAllBytes(lnkFile);
            string ansi = Encoding.GetEncoding(28591).GetString(b).ToLowerInvariant();
            string u0 = Encoding.Unicode.GetString(b).ToLowerInvariant();
            string u1 = b.Length > 1 ? Encoding.Unicode.GetString(b, 1, b.Length - 1 - ((b.Length - 1) % 2)).ToLowerInvariant() : "";
            foreach (var n in needles)
                if (n.Length > 0 && (ansi.Contains(n) || u0.Contains(n) || u1.Contains(n))) return true;
            return false;
        }
        catch { return true; } // na dúvida, resolve-se a sério
    }

    // Atalho de uma instalação que já foi apagada: aponta para um ScrollScape*.exe / launcher nosso que já não existe.
    static bool IsOrphanAppShortcut(string target)
    {
        try
        {
            if (string.IsNullOrEmpty(target) || !Path.IsPathRooted(target) || File.Exists(target) || Directory.Exists(target)) return false;
            string name = Path.GetFileName(target);
            bool app = name.StartsWith(AppExeLike, Ic) && name.EndsWith(".exe", Ic);
            bool launcher = LauncherFiles.Any(l => string.Equals(l, name, Ic));
            if (!app && !launcher) return false;
            // a unidade tem de estar acessível: um atalho para um disco externo desligado NÃO é órfão
            string root = Path.GetPathRoot(target);
            return !string.IsNullOrEmpty(root) && Directory.Exists(root);
        }
        catch { return false; }
    }

    static void FindShortcuts(Plan plan)
    {
        var dirs = new List<string>
        {
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
        };
        dirs.AddRange(extraShortcutDirs);
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        if (t == null) return;
        dynamic shell = Activator.CreateInstance(t);
        var needles = new List<string> { "scrollscape", Norm(plan.InstallDir).ToLowerInvariant() };
        needles.AddRange(plan.Dirs.Select(x => Norm(x).ToLowerInvariant()));
        foreach (var d in dirs.Where(x => !string.IsNullOrEmpty(x) && Directory.Exists(x)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            IEnumerable<string> lnks;
            try { lnks = Directory.EnumerateFiles(d, "*.lnk", SearchOption.AllDirectories).Take(2000).ToList(); }
            catch { continue; }
            foreach (var l in lnks)
            {
                try
                {
                    // Interrogar o Windows por cada um dos centenas de atalhos do Menu Iniciar demora dezenas de segundos.
                    // Um atalho para um ficheiro nosso tem sempre "scrollscape" no destino (o .exe e os launchers têm-no no
                    // nome) ou o caminho de uma pasta que vamos apagar: só esses são resolvidos a sério.
                    if (!ShortcutMentions(l, needles)) continue;
                    dynamic sc = shell.CreateShortcut(l);
                    string target = sc.TargetPath as string;
                    string args = sc.Arguments as string;
                    if (string.IsNullOrEmpty(target)) continue;
                    bool hit = plan.Files.Any(f => string.Equals(Norm(f), Norm(target), Ic))
                               || plan.Dirs.Any(x => IsUnder(target, x))
                               || (!string.IsNullOrEmpty(args) && plan.Files.Any(f => args.IndexOf(f, Ic) >= 0))
                               || IsOrphanAppShortcut(target);
                    if (hit) plan.Shortcuts.Add(l);
                }
                catch { }
            }
        }
    }

    // Regras do Firewall do Windows cujo programa está nos sítios que vamos apagar, ou regras "órfãs" (o ficheiro
    // já nem existe) de instalações antigas do ScrollScape / FlareSolverr. A leitura é feita pela API COM do
    // Firewall (milhares de regras em décimos de segundo) e não precisa de administrador.
    static readonly System.Text.RegularExpressions.Regex OrphanPattern =
        new System.Text.RegularExpressions.Regex(@"\\scrollscape[^\\]*\\|\\tools\\flaresolverr\\", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    static bool IsOurFirewallProgram(string app)
    {
        string name = Path.GetFileName(app).ToLowerInvariant();
        string lower = app.ToLowerInvariant();
        if (name.StartsWith("scrollscape") && name.EndsWith(".exe")) return true;
        if (name == "flaresolverr.exe") return true;
        if ((name == "chrome.exe" || name == "chromedriver.exe") && lower.Contains("\\tools\\flaresolverr\\")) return true;
        if (name == "node.exe" && System.Text.RegularExpressions.Regex.IsMatch(lower, @"\\scrollscape[^\\]*\\(.*\\)?tools\\node\\node\.exe$")) return true;
        return false;
    }

    static void FindFirewall(Plan plan)
    {
        try
        {
            var prefixes = new List<string> { Norm(plan.InstallDir) };
            string home = EnvAny("SCROLLSCAPE_HOME");
            if (!string.IsNullOrWhiteSpace(home)) prefixes.Add(Norm(home));
            Type t = Type.GetTypeFromProgID("HNetCfg.FwPolicy2");
            if (t == null) return;
            dynamic policy = Activator.CreateInstance(t);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (dynamic rule in policy.Rules)
            {
                string app = null;
                try { app = rule.ApplicationName as string; } catch { }
                if (string.IsNullOrEmpty(app) || app == "*" || !Path.IsPathRooted(app) || Path.GetPathRoot(app).Length < 3) continue;
                bool inside = prefixes.Any(p => IsUnder(app, p));
                bool orphan = OrphanPattern.IsMatch(app) && !File.Exists(app);
                if (!inside && !orphan) continue;
                // Só programas do ScrollScape/FlareSolverr, nunca "tudo o que estiver nesta pasta" (ex.: o Firefox portátil ao lado).
                if (!IsOurFirewallProgram(app)) continue;
                // Uma regra só é "órfã" se o disco está acessível e a própria pasta do programa já não existe
                // (um disco externo desligado ou uma partilha offline não contam).
                if (!inside)
                {
                    string root = Path.GetPathRoot(app);
                    string parent = Path.GetDirectoryName(app);
                    if (string.IsNullOrEmpty(root) || !Directory.Exists(root) || string.IsNullOrEmpty(parent) || Directory.Exists(parent)) continue;
                }
                string dir = rule.Direction == 1 ? "entrada" : "saída";
                string action = rule.Action == 0 ? "bloquear" : "permitir";
                if (seen.Add(app + "|" + dir + "|" + action))
                {
                    plan.FirewallDescriptions.Add(dir + " " + action + "  " + app + (inside ? "" : "  (de uma instalação que já não existe)"));
                    if (!plan.FirewallRules.Contains(app, StringComparer.OrdinalIgnoreCase)) plan.FirewallRules.Add(app);
                }
            }
        }
        catch (Exception e) { problems.Add("Não consegui ler as regras do Firewall: " + e.Message); }
    }

    static string TailscaleExe()
    {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string c = Path.Combine(pf, "Tailscale", "tailscale.exe");
        return File.Exists(c) ? c : null;
    }

    static void FindTailscale(Plan plan)
    {
        string ts = TailscaleExe();
        if (ts == null) return;
        try
        {
            var psi = new ProcessStartInfo(ts, "serve status") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            using (var p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd(); p.WaitForExit(15000);
                var m = System.Text.RegularExpressions.Regex.Match(o, @"127\.0\.0\.1:(40\d\d)");
                if (m.Success) plan.TailscaleNote = "127.0.0.1:" + m.Groups[1].Value;
            }
        }
        catch { }
    }

    // ------------------------------------------------------------------ apresentação

    static void Show(Plan p)
    {
        Console.WriteLine("Vou fechar estes processos:"); if (p.Processes.Count == 0) Console.WriteLine("  (nenhum a correr)");
        foreach (var x in p.Processes) Console.WriteLine("  - " + x.Value);
        Console.WriteLine("\nVou apagar:");
        foreach (var d in p.Dirs) Console.WriteLine("  [pasta]    " + d + "   (" + SizeText(d) + ")");
        foreach (var f in p.Files) Console.WriteLine("  [ficheiro] " + f);
        foreach (var l in p.LocalDirs) Console.WriteLine(auto
            ? "  [pasta]    " + l + "   (" + SizeText(l) + ", os seus mangas importados)"
            : "  [pergunto à parte] " + l + "   (" + SizeText(l) + ", os seus mangas importados; por defeito NÃO apago)");
        foreach (var s in p.Shortcuts) Console.WriteLine("  [atalho]   " + s);
        foreach (var m in p.Misc) Console.WriteLine("  [resto]    " + m);
        Console.WriteLine("  [este desinstalador] e, no fim, a pasta " + p.InstallDir + " se ficar vazia");
        if (p.ChromedriverCache != null) Console.WriteLine(auto ? "  [cache]    " + p.ChromedriverCache : "\nPergunto à parte (pode ser usado por outros programas): " + p.ChromedriverCache);
        if (p.FirewallRules.Count > 0)
        {
            Console.WriteLine(auto ? "\nRegras do Firewall do Windows deste programa (o Windows pede permissão de administrador):" : "\nRegras do Firewall do Windows deste programa (pergunto à parte; precisa de administrador):");
            for (int i = 0; i < p.FirewallDescriptions.Count; i++) Console.WriteLine("  - " + p.FirewallDescriptions[i]);
        }
        if (p.TailscaleNote != null) Console.WriteLine("\nTailscale serve a apontar para " + p.TailscaleNote + (auto ? " (não o desligo sozinho: apagaria toda a configuração serve)." : " (pergunto à parte)."));
        foreach (var pr in problems) Console.WriteLine("  ! aviso: " + pr);
        Console.WriteLine();
    }

    static string SizeText(string dir)
    {
        try
        {
            long total = 0; int n = 0;
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) { try { total += new FileInfo(f).Length; n++; } catch { } if (n > 200000) break; }
            return n + " ficheiros, " + (total / 1048576.0).ToString("0.0") + " MB";
        }
        catch { return "tamanho desconhecido"; }
    }

    static void Report(Plan plan)
    {
        Console.WriteLine();
        if (problems.Count > 0) Console.WriteLine("Concluído com avisos:");
        else if (left.Count > 0) Console.WriteLine("Concluído. Ficou apenas o que indico abaixo:");
        else Console.WriteLine("Concluído. Não ficou nada do ScrollScape.");
        foreach (var p in problems) Console.WriteLine("  ! " + p);
        foreach (var l in left) Console.WriteLine("  Ficou: " + l);
    }

    // ------------------------------------------------------------------ ações

    static void Remove(string path, bool isDir)
    {
        try
        {
            if (!Directory.Exists(path) && !File.Exists(path)) return;
            string n = Norm(path);
            if (IsProtectedDir(n)) { problems.Add("Recusei apagar uma pasta protegida: " + n); return; }
            try { Retry(() => DeleteTree(path)); }
            catch (Exception first)
            {
                // Caminhos com mais de ~260 caracteres (a árvore do Chrome do FlareSolverr): o .NET antigo não os atravessa.
                // "rd /s /q" com o prefixo \\?\ apaga-os e remove junctions como ligações, sem as seguir.
                if (!LongPathFallback(path)) throw first;
            }
            anyDeleted = true;
            Console.WriteLine("  apagado: " + path);
        }
        catch (Exception e) { problems.Add("Não consegui apagar " + path + " (" + e.Message + ")"); left.Add(path); }
    }

    static bool LongPathFallback(string path)
    {
        try
        {
            if (!Directory.Exists(path) || Reparse(path)) return false;
            string full = Path.GetFullPath(path).TrimEnd('\\');
            if (IsProtectedDir(full) || full.IndexOfAny(new[] { '%', '!', '^', '"', '&' }) >= 0) return false;
            var psi = new ProcessStartInfo("cmd.exe", "/c rd /s /q " + Q(@"\\?\" + full))
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            using (var p = Process.Start(psi)) { p.StandardOutput.ReadToEnd(); p.StandardError.ReadToEnd(); p.WaitForExit(120000); }
            return !Directory.Exists(path);
        }
        catch { return false; }
    }

    // Copia bytes de um fluxo para outro (até ao fim da origem), a vaza imediatamente: serve para encaminhar a entrada/saída.
    static void Pump(Stream from, Stream to)
    {
        try
        {
            var buf = new byte[4096];
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); }
        }
        catch { }
    }

    static string NextArg(string[] args, ref int i)
    {
        if (i + 1 >= args.Length) { Console.Error.WriteLine("A opção " + args[i] + " precisa de um valor."); Environment.Exit(3); }
        return args[++i];
    }

    static void RemoveIfEmpty(string dir)
    {
        try
        {
            if (!Directory.Exists(dir) || Reparse(dir)) return;
            if (IsProtectedDir(dir)) return; // ex.: o desinstalador estava solto em Transferências
            if (Directory.EnumerateFileSystemEntries(dir).Any(e => !IsSelfArtifact(e)))
            {
                if (string.Equals(Norm(dir), Norm(workerDir ?? ""), Ic))
                    left.Add(dir + "  (tem ficheiros que não são do ScrollScape; não lhes toquei)");
                return;
            }
            // só restam ficheiros nossos (o desinstalador) - o apagar final trata deles
            if (!Directory.EnumerateFileSystemEntries(dir).Any()) { Retry(() => Directory.Delete(dir, false)); Console.WriteLine("  pasta vazia removida: " + dir); }
        }
        catch (Exception e) { problems.Add("Pasta " + dir + ": " + e.Message); }
    }

    static bool IsSelfArtifact(string entry)
    {
        string n = Path.GetFileName(entry);
        return !string.IsNullOrEmpty(parentExe) && string.Equals(Norm(entry), Norm(parentExe), Ic)
               || n.StartsWith("ScrollScape-uninstall-", Ic);
    }

    static void KillProcess(int pid, string label, string expectedPath)
    {
        try
        {
            // O utilizador pode ter ficado minutos na pergunta: o PID pode ter sido reutilizado por outro programa.
            if (expectedPath != null)
            {
                string now = null;
                using (var s = new ManagementObjectSearcher("SELECT ExecutablePath FROM Win32_Process WHERE ProcessId=" + pid))
                    foreach (ManagementObject o in s.Get()) now = o["ExecutablePath"] as string;
                if (now == null) return; // já terminou
                if (!string.Equals(Norm(now), Norm(expectedPath), Ic)) { problems.Add("Não fechei " + label + ": o PID passou a ser de outro programa."); return; }
            }
            var p = Process.GetProcessById(pid);
            p.Kill(); p.WaitForExit(5000);
            Console.WriteLine("  fechado: " + label);
        }
        catch (ArgumentException) { /* já tinha terminado */ }
        catch (Exception e) { problems.Add("Não consegui fechar " + label + ": " + e.Message); }
    }

    // Remove (como administrador, depois de o utilizador aceitar o pedido do Windows) só as regras cujo programa
    // é EXATAMENTE um dos caminhos listados. Nunca por nome: "chrome.exe" de outros programas fica intacto.
    static void RemoveFirewall(Plan plan)
    {
        string script =
            "$paths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)\n" +
            "foreach ($x in ($env:SS_PATHS -split '[|]')) { if ($x -and [IO.Path]::IsPathRooted($x) -and $x.Length -gt 3) { [void]$paths.Add($x) } }\n" +
            "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -and $paths.Contains([string]$_.Program) } | ForEach-Object {\n" +
            "  Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $_ -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue }\n";
        string b64 = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        try
        {
            Console.WriteLine("  a remover regras do Firewall (pode demorar cerca de um minuto)...");
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + b64)
            { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
            // Com UseShellExecute não se pode passar o ambiente: os caminhos vão por variável de utilizador temporária do processo atual.
            Environment.SetEnvironmentVariable("SS_PATHS", string.Join("|", plan.FirewallRules.ToArray()));
            using (var p = Process.Start(psi)) { p.WaitForExit(300000); }
            Environment.SetEnvironmentVariable("SS_PATHS", null);
            var again = new Plan { InstallDir = plan.InstallDir };
            FindFirewall(again);
            int still = again.FirewallRules.Intersect(plan.FirewallRules, StringComparer.OrdinalIgnoreCase).Count();
            if (still > 0) problems.Add(still + " regra(s) do Firewall continuam (recusou o administrador?). Pode apagá-las em 'Firewall do Windows com Segurança Avançada'.");
            else Console.WriteLine("  regras do Firewall removidas.");
        }
        catch (System.ComponentModel.Win32Exception) { problems.Add("Firewall: o pedido de administrador foi recusado; as regras ficaram."); }
        catch (Exception e) { problems.Add("Firewall: " + e.Message); }
    }

    static void RunQuiet(string exe, string args)
    {
        if (exe == null) return;
        try
        {
            var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var p = Process.Start(psi)) { p.StandardOutput.ReadToEnd(); p.WaitForExit(20000); }
            Console.WriteLine("  executado: tailscale " + args);
        }
        catch (Exception e) { problems.Add("tailscale " + args + ": " + e.Message); }
    }

    // O worker só termina depois do pai (que está em espera); esta tarefa invisível apaga os dois .exe e a pasta, se vazia.
    static void ScheduleSelfDelete(string installDir)
    {
        try
        {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            // cmd.exe expande %VAR%, !x! e ^ mesmo entre aspas: com esses carateres no caminho não se agenda nada.
            if (new[] { self, parentExe ?? "", installDir }.Any(p => p.IndexOfAny(new[] { '%', '!', '^' }) >= 0))
            {
                left.Add((parentExe ?? self) + "  (este desinstalador: apague-o à mão; o caminho tem % ! ou ^)");
                return;
            }
            // O utilizador pode demorar minutos a carregar numa tecla (o programa fica à espera dele): um número fixo de
            // tentativas curtas falhava e deixava o uninstall.exe e a pasta para trás. Por isso tenta-se a cada segundo,
            // até ~10 minutos, e só quando os ficheiros já saíram se remove a pasta (se ficou vazia) e termina.
            // Um pequeno script .cmd temporário (em vez de uma linha de comando comprida) é fácil de verificar e não depende
            // de como o cmd interpreta ciclos "for" com canais redirecionados.
            var files = new List<string>();
            if (!string.IsNullOrEmpty(parentExe)) files.Add(parentExe);
            files.Add(self);
            string sub = Path.Combine(installDir, "ScrollScape");
            var bat = new StringBuilder();
            bat.AppendLine("@echo off");
            bat.AppendLine("ping 127.0.0.1 -n 3 >nul");
            bat.AppendLine("set n=0");
            bat.AppendLine(":loop");
            foreach (var f in files) bat.Append("del /f /q ").Append(Q(f)).AppendLine(" >nul 2>&1");
            foreach (var f in files) bat.Append("if exist ").Append(Q(f)).AppendLine(" goto wait");
            bat.AppendLine("goto done");
            bat.AppendLine(":wait");
            bat.AppendLine("set /a n+=1");
            bat.AppendLine("if %n% geq 600 goto done");
            bat.AppendLine("ping 127.0.0.1 -n 2 >nul");
            bat.AppendLine("goto loop");
            bat.AppendLine(":done");
            if (anyDeleted && !IsProtectedDir(installDir)) bat.Append("rmdir ").Append(Q(installDir)).AppendLine(" >nul 2>&1");
            if (anyDeleted && Directory.Exists(sub) && !IsProtectedDir(sub)) bat.Append("rmdir ").Append(Q(sub)).AppendLine(" >nul 2>&1");
            bat.AppendLine("(goto) 2>nul & del /f /q \"%~f0\"");
            string script = Path.Combine(Path.GetTempPath(), "ScrollScape-limpeza-" + Guid.NewGuid().ToString("N") + ".cmd");
            File.WriteAllText(script, bat.ToString(), Encoding.Default);
            // Com os três canais redirecionados o cmd não herda os do worker (que seguravam o pai vivo e o ficheiro bloqueado).
            // A pasta de trabalho do cmd NÃO pode ser a pasta a apagar: o processo herdaria a do worker (a pasta do programa, que o
            // Windows define ao fazer duplo clique) e uma pasta que é a pasta de trabalho de alguém não se apaga: ficava vazia mas lá.
            var psi = new ProcessStartInfo("cmd.exe", "/c " + Q(script)) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = Path.GetTempPath(), RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            Process.Start(psi);
        }
        catch { }
    }

    // ------------------------------------------------------------------ utilitários

    static string Norm(string p) { return Path.GetFullPath(p).TrimEnd('\\', '/'); }

    static bool IsUnder(string child, string parent)
    {
        // Um nome relativo ("System") seria resolvido contra a pasta atual e pareceria estar "dentro"; só caminhos absolutos contam.
        if (string.IsNullOrEmpty(child) || !Path.IsPathRooted(child) || Path.GetPathRoot(child).Length < 3) return false;
        try
        {
            string c = Norm(child), p = Norm(parent);
            return c.Length > p.Length && c.StartsWith(p + "\\", Ic);
        }
        catch { return false; }
    }

    static bool Reparse(string path)
    {
        try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; } catch { return false; }
    }

    static string EnvAny(string name)
    {
        return Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Process)
            ?? Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);
    }

    // O .exe do próprio programa: ScrollScape*.exe, mas não instaladores de terceiros com nome parecido.
    // Os .exe empacotados são grandes (Node dentro), ou terminam em "-win.exe" como os que o projeto gera.
    static bool IsAppExe(string f)
    {
        string name = Path.GetFileName(f);
        if (!name.StartsWith(AppExeLike, Ic) || !name.EndsWith(".exe", Ic)) return false;
        if (name.StartsWith("ScrollScape-uninstall-", Ic)) return false;
        if (System.Text.RegularExpressions.Regex.IsMatch(name, "setup|install|uninst", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return false;
        try { return name.EndsWith("-win.exe", Ic) || new FileInfo(f).Length > 20L * 1024 * 1024; } catch { return false; }
    }

    // O store.json é do ScrollScape se tiver as duas chaves que o app cria sempre.
    static bool IsScrollScapeStore(string file)
    {
        try
        {
            var fi = new FileInfo(file);
            if (!fi.Exists || fi.Length > 64L * 1024 * 1024) return false;
            string t = File.ReadAllText(file);
            return t.IndexOf("\"installedSources\"", StringComparison.Ordinal) >= 0 && t.IndexOf("\"repos\"", StringComparison.Ordinal) >= 0;
        }
        catch { return false; }
    }

    // Uma instalação que nunca chegou a arrancar (ou que fechou ao arrancar) não tem store.json: só a pasta "data"
    // com o que o app cria logo ao início. Conta como nossa se ao lado está o .exe do programa e TUDO o que lá
    // está tem nome de coisa que o app cria (nada de ficheiros estranhos).
    static readonly string[] KnownDataEntries =
    {
        "store.json", "store.json.tmp", "store.json.bak", "setup.json", "error-log.json", "tmp", "cache", "sources",
        "theme-presets", "source-staging", "site-denylist.txt", ".scrollscape.lock"
    };

    static bool PartialInstallData(string root, string data)
    {
        try
        {
            if (!Directory.Exists(data) || Reparse(data)) return false;
            if (!Directory.GetFiles(root, "ScrollScape*.exe").Any(IsAppExe)) return false;
            var names = Directory.GetFileSystemEntries(data).Select(Path.GetFileName).ToList();
            return names.Count > 0 && names.All(n => KnownDataEntries.Any(k => string.Equals(k, n, Ic)));
        }
        catch { return false; }
    }

    static bool SetupLooksOurs(string file)
    {
        try
        {
            if (!File.Exists(file) || new FileInfo(file).Length > 65536) return false;
            string t = File.ReadAllText(file);
            return t.IndexOf("\"flaresolverr\"", StringComparison.Ordinal) >= 0;
        }
        catch { return false; }
    }

    // Copia uma pasta sem seguir ligações (junctions/symlinks são ignoradas).
    static void CopyTree(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.GetFiles(src))
            if (!Reparse(f)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), false);
        foreach (var d in Directory.GetDirectories(src))
            if (!Reparse(d)) CopyTree(d, Path.Combine(dst, Path.GetFileName(d)));
    }

    // Uma barra no fim ("E:\") escaparia a aspa final: duplica-se.
    static string Q(string s) { return "\"" + (s.EndsWith("\\") ? s + "\\" : s) + "\""; }

    static string Long(string p)
    {
        if (p.StartsWith(@"\\?\")) return p;
        return p.Length > 240 ? @"\\?\" + Path.GetFullPath(p) : p;
    }

    // Apaga sem nunca seguir ligações (junctions/symlinks): uma ligação é removida, o destino fica intacto.
    static void DeleteTree(string path)
    {
        path = Long(path);
        FileAttributes a = File.GetAttributes(path);
        if ((a & FileAttributes.ReparsePoint) != 0)
        {
            if ((a & FileAttributes.Directory) != 0) Directory.Delete(path, false); else { File.SetAttributes(path, FileAttributes.Normal); File.Delete(path); }
            return;
        }
        if ((a & FileAttributes.Directory) == 0) { File.SetAttributes(path, FileAttributes.Normal); File.Delete(path); return; }
        foreach (var e in Directory.GetFileSystemEntries(path)) DeleteTree(e);
        File.SetAttributes(path, FileAttributes.Normal);
        Directory.Delete(path, false);
    }

    static void Retry(Action a)
    {
        for (int i = 0; ; i++)
        {
            try { a(); return; }
            catch (IOException) { if (i >= 4) throw; Thread.Sleep(400); }      // antivírus / indexador a segurar o ficheiro
            catch (UnauthorizedAccessException) { if (i >= 4) throw; Thread.Sleep(400); }
        }
    }

    static bool Ask(string q, bool defaultYes)
    {
        if (yes) return defaultYes;
        if (auto) { Console.WriteLine(q + " -> sim"); return true; }
        Console.Write(q + (defaultYes ? " [S/n] " : " [s/N] "));
        // Com a entrada redirecionada (script, teste) lê-se na mesma; se acabar (EOF) vale a resposta por defeito.
        string line = null;
        try { line = Console.ReadLine(); } catch { }
        if (line == null) Console.WriteLine();
        // Um script pode enviar a resposta com uma marca BOM invisível à frente ("﻿s"): ignora-se.
        // Depende da página de códigos, a marca BOM chega como U+FEFF ou como símbolos ("∩╗┐"): só contam as letras.
        string a = new string((line ?? "").Where(char.IsLetter).ToArray()).ToLowerInvariant();
        if (a.Length == 0) return defaultYes;
        return a == "s" || a == "sim" || a == "y" || a == "yes";
    }

    static int Pause(int code)
    {
        if (!yes && !dryRun && !Console.IsInputRedirected)
        {
            Console.WriteLine("\nPrima Enter para fechar.");
            try { Console.ReadLine(); } catch { }
        }
        return code;
    }

    static void Help()
    {
        Console.WriteLine("uninstall.exe [--ask] [--dry-run] [--yes]\n  (sem opções) não pergunta nada e apaga tudo\n  --ask      pergunta antes de apagar e antes de cada extra\n  --dry-run  mostra o que apagaria, sem apagar\n  --yes      não pergunta; só o essencial: não mexe em Firewall, Tailscale nem na cache partilhada");
    }
}
