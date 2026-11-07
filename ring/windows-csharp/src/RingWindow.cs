using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace HuanmengRing
{
    internal sealed class RingWindow : Window
    {
        private readonly AppController _app;
        private readonly PresetStore _store;
        private readonly AppConfig _config;
        private readonly Canvas _canvas;
        private readonly List<Sector> _sectors = new List<Sector>();
        private readonly List<SectorItem> _items = new List<SectorItem>();
        private RingTheme _theme;
        private int _level; // 0 = categories, 1 = presets
        private string _category = "";
        private int _hover = -1;
        private double _cx;
        private double _cy;
        private double _outer;
        private double _inner;
        private TextBlock _hubTitle;
        private TextBlock _hubSub;
        private TextBlock _hubStatus;
        private Line _directionLine;
        private DispatcherTimer _hoverTimer;
        private bool _connected;
        private bool _hiding;

        private sealed class Sector
        {
            public Path Shape;
            public Brush Base;
            public double Start;
            public double End;
            public TextBlock Label;
            public double LabelRadius;
            public double LabelFontSize;
        }

        private sealed class SectorItem
        {
            public string Title;
            public string Subtitle;
            public Preset Preset;
        }

        public RingWindow(AppController app, PresetStore store, AppConfig config)
        {
            _app = app;
            _store = store;
            _config = config;

            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0));
            Topmost = true;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.Manual;
            Focusable = true;
            ShowActivated = true;
            FontFamily = new FontFamily("Microsoft YaHei UI");

            _canvas = new Canvas();
            _canvas.Background = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0));
            _canvas.MouseLeftButtonUp += CanvasMouseLeftButtonUp;
            _canvas.MouseRightButtonDown += CanvasMouseRightButtonDown;
            _canvas.MouseMove += delegate { UpdateHoverFromMouse(); };
            Content = _canvas;

            _hoverTimer = new DispatcherTimer();
            _hoverTimer.Interval = TimeSpan.FromMilliseconds(28);
            _hoverTimer.Tick += delegate { UpdateHoverFromMouse(); };

            KeyDown += RingKeyDown;
        }

        public void SetBridgeConnected(bool connected)
        {
            _connected = connected;
            if (_hubStatus != null)
            {
                _hubStatus.Text = connected ? "插件已连接" : "插件未连接";
                _hubStatus.Foreground = connected ? _theme.Accent : _theme.Sub;
            }
        }

        public void ShowRing()
        {
            double left = SystemParameters.VirtualScreenLeft;
            double top = SystemParameters.VirtualScreenTop;
            double width = SystemParameters.VirtualScreenWidth;
            double height = SystemParameters.VirtualScreenHeight;
            Left = left;
            Top = top;
            Width = width;
            Height = height;
            _level = 0;
            _category = "";
            _hover = -1;
            Show();
            UpdateLayout();
            Activate();
            Focus();

            Point cursor;
            try
            {
                System.Drawing.Point screen = System.Windows.Forms.Cursor.Position;
                cursor = PointFromScreen(new Point(screen.X, screen.Y));
            }
            catch
            {
                cursor = new Point(width / 2, height / 2);
            }

            double radius = _config.OuterRadius;
            double available = Math.Min(width, height);
            if (radius * 2 + 90 > available) radius = Math.Max(110, (available - 90) / 2);
            _outer = radius;
            _inner = radius * (1.0 - _config.BandRatio);
            if (_inner < 54) _inner = 54;
            double safe = radius + 42;
            if (cursor.X < safe || cursor.X > width - safe || cursor.Y < safe || cursor.Y > height - safe)
            {
                // 光标贴着屏幕边缘时，如果硬按光标画，圆环会被切掉一半。
                // 这种情况下宁可退到屏幕中心，保证整个圆环可见。
                _cx = width / 2;
                _cy = height / 2;
            }
            else
            {
                _cx = cursor.X;
                _cy = cursor.Y;
            }

            Draw();
            if (_config.Animation)
            {
                _canvas.Opacity = 0;
                _canvas.RenderTransform = new ScaleTransform(_config.AppearScale, _config.AppearScale, _cx, _cy);
                DoubleAnimation fade = new DoubleAnimation(0, _config.Opacity, TimeSpan.FromMilliseconds(110));
                fade.EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut };
                _canvas.BeginAnimation(UIElement.OpacityProperty, fade);
                DoubleAnimation grow = new DoubleAnimation(_config.AppearScale, 1.0, TimeSpan.FromMilliseconds(110));
                grow.EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut };
                ScaleTransform transform = (ScaleTransform)_canvas.RenderTransform;
                transform.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
                transform.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            }
            else
            {
                _canvas.Opacity = _config.Opacity;
                _canvas.RenderTransform = Transform.Identity;
            }
            _hoverTimer.Start();
        }

        public void HideRing()
        {
            if (_hiding) return;
            _hiding = true;
            try
            {
                _hoverTimer.Stop();
                Hide();
                _level = 0;
                _category = "";
                _hover = -1;
                _sectors.Clear();
                _items.Clear();
                _canvas.Children.Clear();
                _hubTitle = null;
                _hubSub = null;
                _hubStatus = null;
                _directionLine = null;
            }
            finally
            {
                _hiding = false;
            }
        }

        public void RefreshPresets()
        {
            if (!IsVisible) return;
            if (_level == 1 && _store.InCategory(_category).Count == 0)
            {
                _level = 0;
                _category = "";
            }
            Draw();
        }

        private void Draw()
        {
            _canvas.Children.Clear();
            _sectors.Clear();
            _items.Clear();
            _theme = RingTheme.For(_config.Theme);

            _items.AddRange(BuildItems());
            if (_items.Count == 0)
            {
                DrawEmpty();
                return;
            }

            // 旧版是同形状的环带投影，不是一整块圆饼；这样中空区域不会发灰。
            if (_config.ShadowEnabled)
            {
                Path shadow = new Path();
                shadow.Data = BuildFullRing(_cy + _config.ShadowOffsetY, _outer + 2, _inner);
                shadow.Fill = new SolidColorBrush(Color.FromArgb(
                    (byte)Math.Max(0, Math.Min(255, _config.ShadowAlpha * 255.0)), 0, 0, 0));
                shadow.Effect = new BlurEffect { Radius = Math.Max(2, _config.ShadowBlur) };
                shadow.IsHitTestVisible = false;
                _canvas.Children.Add(shadow);
            }

            int count = _items.Count;
            double step = 360.0 / count;
            double gap = Math.Min(_config.GapMax, Math.Max(0.0, step * _config.GapRatio));
            for (int i = 0; i < count; i++)
            {
                double start = -90.0 + i * step + gap / 2.0;
                double end = -90.0 + (i + 1) * step - gap / 2.0;
                double baseRadius = (_inner + _outer) / 2.0;
                double fontSize = _level == 0 ? 10.5 : 10.0;
                Brush baseFill = (i % 2 == 1) ? _theme.SectorAlt : _theme.Sector;

                Path path = new Path();
                path.Data = BuildSector(start, end, count == 1, _outer);
                path.Fill = baseFill;
                path.Stroke = _theme.Stroke;
                path.StrokeThickness = 1;
                path.Cursor = Cursors.Hand;
                _canvas.Children.Add(path);

                string label = _level == 0 ? ShortCategory(_items[i].Title) : ShortPreset(_items[i].Title);
                TextBlock labelBlock = AddLabel(label, -90.0 + (i + 0.5) * step, baseRadius, fontSize, _theme.Text, true);
                Panel.SetZIndex(labelBlock, 2);
                _sectors.Add(new Sector
                {
                    Shape = path,
                    Base = baseFill,
                    Start = start,
                    End = end,
                    Label = labelBlock,
                    LabelRadius = baseRadius,
                    LabelFontSize = fontSize
                });
            }

            // 外圈细线
            Ellipse border = new Ellipse();
            border.Width = _outer * 2;
            border.Height = _outer * 2;
            border.Stroke = _theme.Stroke;
            border.StrokeThickness = 1;
            border.Fill = Brushes.Transparent;
            Canvas.SetLeft(border, _cx - _outer);
            Canvas.SetTop(border, _cy - _outer);
            _canvas.Children.Add(border);

            _directionLine = new Line();
            _directionLine.Stroke = _theme.Accent;
            _directionLine.StrokeThickness = 2;
            _directionLine.Opacity = 0.6;
            _directionLine.Visibility = Visibility.Collapsed;
            _directionLine.IsHitTestVisible = false;
            Panel.SetZIndex(_directionLine, 1);
            _canvas.Children.Add(_directionLine);

            DrawHub();
            DrawHint();
            _hover = -1;
            UpdateHoverFromMouse();
        }

        private Geometry BuildFullRing(double centerY, double outer, double inner)
        {
            EllipseGeometry outerGeometry = new EllipseGeometry(new Point(_cx, centerY), outer, outer);
            EllipseGeometry innerGeometry = new EllipseGeometry(new Point(_cx, centerY), inner, inner);
            return new CombinedGeometry(GeometryCombineMode.Exclude, outerGeometry, innerGeometry);
        }

        private void DrawHub()
        {
            double radius = Math.Max(60, _inner - 8);
            Ellipse hub = new Ellipse();
            hub.Width = radius * 2;
            hub.Height = radius * 2;
            hub.Fill = _theme.Hub;
            hub.Stroke = _theme.Accent;
            hub.StrokeThickness = 1.2;
            if (_config.ShadowEnabled)
            {
                hub.Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = Math.Max(4, _config.ShadowBlur),
                    ShadowDepth = Math.Max(0, _config.ShadowOffsetY),
                    Opacity = _config.ShadowAlpha,
                    Direction = 270
                };
            }
            hub.Cursor = Cursors.Hand;
            hub.MouseLeftButtonUp += delegate { HubClick(); };
            Canvas.SetLeft(hub, _cx - radius);
            Canvas.SetTop(hub, _cy - radius);
            _canvas.Children.Add(hub);

            Ellipse dot = new Ellipse();
            dot.Width = 7;
            dot.Height = 7;
            dot.Fill = _theme.Accent;
            Canvas.SetLeft(dot, _cx - 3.5);
            Canvas.SetTop(dot, _cy - radius + 16);
            _canvas.Children.Add(dot);

            _hubTitle = new TextBlock();
            _hubTitle.Width = radius * 1.8;
            _hubTitle.TextAlignment = TextAlignment.Center;
            _hubTitle.TextWrapping = TextWrapping.NoWrap;
            _hubTitle.TextTrimming = TextTrimming.CharacterEllipsis;
            _hubTitle.FontSize = 16;
            _hubTitle.FontWeight = FontWeights.SemiBold;
            _hubTitle.Foreground = _theme.Text;
            _hubTitle.IsHitTestVisible = false;
            Canvas.SetLeft(_hubTitle, _cx - radius * 0.9);
            Canvas.SetTop(_hubTitle, _cy - 23);
            _canvas.Children.Add(_hubTitle);

            _hubSub = new TextBlock();
            _hubSub.Width = radius * 1.8;
            _hubSub.TextAlignment = TextAlignment.Center;
            _hubSub.TextWrapping = TextWrapping.NoWrap;
            _hubSub.TextTrimming = TextTrimming.CharacterEllipsis;
            _hubSub.FontSize = 9.2;
            _hubSub.Foreground = _theme.Sub;
            _hubSub.IsHitTestVisible = false;
            Canvas.SetLeft(_hubSub, _cx - radius * 0.9);
            Canvas.SetTop(_hubSub, _cy + 3);
            _canvas.Children.Add(_hubSub);

            _hubStatus = new TextBlock();
            _hubStatus.Width = radius * 1.8;
            _hubStatus.TextAlignment = TextAlignment.Center;
            _hubStatus.FontSize = 7.6;
            _hubStatus.Foreground = _connected ? _theme.Accent : _theme.Sub;
            _hubStatus.Text = _connected ? "插件已连接" : "插件未连接";
            _hubStatus.IsHitTestVisible = false;
            Canvas.SetLeft(_hubStatus, _cx - radius * 0.9);
            Canvas.SetTop(_hubStatus, _cy + radius - 25);
            _canvas.Children.Add(_hubStatus);

            ResetHub();
        }

        private void DrawEmpty()
        {
            Ellipse hub = new Ellipse();
            hub.Width = 150;
            hub.Height = 150;
            hub.Fill = _theme.Hub;
            hub.Stroke = _theme.Stroke;
            Canvas.SetLeft(hub, _cx - 75);
            Canvas.SetTop(hub, _cy - 75);
            _canvas.Children.Add(hub);

            TextBlock title = new TextBlock();
            title.Text = "没有预设";
            title.FontSize = 14;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = _theme.Text;
            title.TextAlignment = TextAlignment.Center;
            title.Width = 130;
            Canvas.SetLeft(title, _cx - 65);
            Canvas.SetTop(title, _cy - 18);
            _canvas.Children.Add(title);

            TextBlock sub = new TextBlock();
            sub.Text = _connected ? "插件已连接，但没收到预设" : "先启动 Photoshop 插件";
            sub.FontSize = 8;
            sub.Foreground = _theme.Sub;
            sub.TextAlignment = TextAlignment.Center;
            sub.Width = 190;
            sub.TextWrapping = TextWrapping.Wrap;
            Canvas.SetLeft(sub, _cx - 95);
            Canvas.SetTop(sub, _cy + 6);
            _canvas.Children.Add(sub);
            DrawHint();
        }

        private void DrawHint()
        {
            TextBlock hint = new TextBlock();
            hint.Text = "Esc 关闭    ·    右键返回    ·    数字键 1-9 选择";
            hint.FontSize = 8;
            hint.Foreground = _theme.Sub;
            hint.TextAlignment = TextAlignment.Center;
            hint.Width = 360;
            Canvas.SetLeft(hint, _cx - 180);
            double y = _cy + _outer + 30;
            if (y > ActualHeight - 34) y = ActualHeight - 34;
            Canvas.SetTop(hint, y);
            _canvas.Children.Add(hint);
        }

        private List<SectorItem> BuildItems()
        {
            List<SectorItem> result = new List<SectorItem>();
            if (_level == 0)
            {
                List<string> categories = _store.Categories();
                for (int i = 0; i < categories.Count; i++)
                {
                    result.Add(new SectorItem
                    {
                        Title = categories[i],
                        Subtitle = _store.CountInCategory(categories[i]) + " 条预设"
                    });
                }
            }
            else
            {
                List<Preset> presets = _store.InCategory(_category);
                for (int i = 0; i < presets.Count; i++)
                {
                    result.Add(new SectorItem
                    {
                        Title = presets[i].Name,
                        Subtitle = presets[i].Category,
                        Preset = presets[i]
                    });
                }
            }
            return result;
        }

        private void UpdateHoverFromMouse()
        {
            if (_hiding || !IsVisible || _items.Count == 0) return;
            Point point;
            try
            {
                System.Drawing.Point screen = System.Windows.Forms.Cursor.Position;
                point = PointFromScreen(new Point(screen.X, screen.Y));
            }
            catch
            {
                point = Mouse.GetPosition(_canvas);
            }
            double dx = point.X - _cx;
            double dy = point.Y - _cy;
            double distance = Math.Sqrt(dx * dx + dy * dy);
            if (distance < _inner || distance > _outer + _config.PopDistance)
            {
                SetHover(-1);
                return;
            }

            double angle = Math.Atan2(dy, dx) * 180.0 / Math.PI;
            if (angle < 0) angle += 360.0;
            int count = _items.Count;
            double step = 360.0 / count;
            double gap = Math.Min(_config.GapMax, Math.Max(0.0, step * _config.GapRatio));
            double fromStart = angle - (270.0 + gap / 2.0);
            while (fromStart < 0) fromStart += 360.0;
            int index = (int)Math.Floor(fromStart / step);
            if (index < 0) index = 0;
            if (index >= count) index = count - 1;
            SetHover(index);
        }

        private void SetHover(int index)
        {
            if (index == _hover) return;

            if (_hover >= 0 && _hover < _sectors.Count)
                RestoreSector(_sectors[_hover]);

            _hover = index;
            if (index < 0 || index >= _sectors.Count || index >= _items.Count)
            {
                if (_directionLine != null) _directionLine.Visibility = Visibility.Collapsed;
                ResetHub();
                return;
            }

            Sector sector = _sectors[index];
            double pop = _config.PopDistance;
            sector.Shape.Data = BuildSector(sector.Start, sector.End, _items.Count == 1, _outer + pop);
            sector.Shape.Fill = _theme.Hover;
            sector.Shape.Stroke = _theme.Accent;
            sector.Shape.StrokeThickness = 2.2;
            sector.Shape.Effect = new DropShadowEffect
            {
                Color = ((SolidColorBrush)_theme.Accent).Color,
                BlurRadius = 16,
                ShadowDepth = 0,
                Opacity = 0.62
            };
            if (sector.Label != null)
            {
                sector.Label.Foreground = _theme.Text;
                PositionLabel(sector.Label, (sector.Start + sector.End) / 2.0, sector.LabelRadius + pop * 0.5);
            }
            if (_hubTitle != null)
            {
                _hubTitle.Text = _items[index].Title;
                _hubSub.Text = _items[index].Subtitle;
            }
            if (_config.ShowDirectionLine && _directionLine != null)
            {
                double mid = ((sector.Start + sector.End) / 2.0) * Math.PI / 180.0;
                double r0 = _inner - 4;
                double r1 = _outer - 6;
                _directionLine.X1 = _cx + Math.Cos(mid) * r0;
                _directionLine.Y1 = _cy + Math.Sin(mid) * r0;
                _directionLine.X2 = _cx + Math.Cos(mid) * r1;
                _directionLine.Y2 = _cy + Math.Sin(mid) * r1;
                _directionLine.Visibility = Visibility.Visible;
            }
        }

        private void RestoreSector(Sector sector)
        {
            if (sector == null) return;
            sector.Shape.Data = BuildSector(sector.Start, sector.End, _items.Count == 1, _outer);
            sector.Shape.Fill = sector.Base;
            sector.Shape.Stroke = _theme.Stroke;
            sector.Shape.StrokeThickness = 1;
            sector.Shape.Effect = null;
            if (sector.Label != null)
                PositionLabel(sector.Label, (sector.Start + sector.End) / 2.0, sector.LabelRadius);
        }

        private void ResetHub()
        {
            if (_hubTitle == null) return;
            if (_level == 0)
            {
                _hubTitle.Text = "预设";
                _hubSub.Text = "选择分类 · " + _items.Count + " 类";
            }
            else
            {
                _hubTitle.Text = _category;
                _hubSub.Text = "选择预设 · 点中心返回";
            }
        }

        private void Activate(int index)
        {
            if (index < 0 || index >= _items.Count) return;
            if (_level == 0)
            {
                _category = _items[index].Title;
                _level = 1;
                _hover = -1;
                Draw();
                return;
            }
            Preset preset = _items[index].Preset;
            if (preset != null)
            {
                HideRing();
                _app.ApplyPreset(preset);
            }
        }

        private void HubClick()
        {
            if (_level == 1)
            {
                _level = 0;
                _category = "";
                _hover = -1;
                Draw();
            }
            else
            {
                HideRing();
            }
        }

        private void CanvasMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (_hiding || _items.Count == 0) return;
            Point point = e.GetPosition(_canvas);
            double dx = point.X - _cx;
            double dy = point.Y - _cy;
            double distance = Math.Sqrt(dx * dx + dy * dy);
            if (distance < _inner) return; // 中心按钮自己处理
            if (distance > _outer + _config.PopDistance)
            {
                HideRing();
                return;
            }

            double angle = Math.Atan2(dy, dx) * 180.0 / Math.PI;
            if (angle < 0) angle += 360.0;
            int count = _items.Count;
            double step = 360.0 / count;
            double gap = Math.Min(_config.GapMax, Math.Max(0.0, step * _config.GapRatio));
            double fromStart = angle - (270.0 + gap / 2.0);
            while (fromStart < 0) fromStart += 360.0;
            int index = (int)Math.Floor(fromStart / step);
            if (index < 0) index = 0;
            if (index >= count) index = count - 1;
            e.Handled = true;
            Activate(index);
        }

        private void CanvasMouseRightButtonDown(object sender, MouseButtonEventArgs e)
        {
            e.Handled = true;
            if (_level == 1)
            {
                _level = 0;
                _category = "";
                _hover = -1;
                Draw();
            }
            else
            {
                HideRing();
            }
        }

        private void RingKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Escape)
            {
                e.Handled = true;
                if (_level == 1)
                {
                    _level = 0;
                    _category = "";
                    _hover = -1;
                    Draw();
                }
                else
                {
                    HideRing();
                }
                return;
            }
            if (e.Key == Key.Back || e.Key == Key.Left)
            {
                if (_level == 1)
                {
                    e.Handled = true;
                    _level = 0;
                    _category = "";
                    _hover = -1;
                    Draw();
                }
                return;
            }
            int number = -1;
            if (e.Key >= Key.D1 && e.Key <= Key.D9) number = (int)e.Key - (int)Key.D1;
            if (e.Key >= Key.NumPad1 && e.Key <= Key.NumPad9) number = (int)e.Key - (int)Key.NumPad1;
            if (number >= 0 && number < _items.Count)
            {
                e.Handled = true;
                Activate(number);
            }
        }

        private Geometry BuildSector(double start, double end, bool full, double outerRadius)
        {
            if (full)
            {
                EllipseGeometry outer = new EllipseGeometry(new Point(_cx, _cy), outerRadius, outerRadius);
                EllipseGeometry inner = new EllipseGeometry(new Point(_cx, _cy), _inner, _inner);
                return new CombinedGeometry(GeometryCombineMode.Exclude, outer, inner);
            }

            Point p1 = PointOn(start, outerRadius);
            Point p2 = PointOn(end, outerRadius);
            Point p3 = PointOn(end, _inner);
            Point p4 = PointOn(start, _inner);
            bool large = Math.Abs(end - start) > 180;

            PathFigure figure = new PathFigure();
            figure.StartPoint = p1;
            figure.Segments.Add(new ArcSegment(p2, new Size(outerRadius, outerRadius), 0, large, SweepDirection.Clockwise, true));
            figure.Segments.Add(new LineSegment(p3, true));
            figure.Segments.Add(new ArcSegment(p4, new Size(_inner, _inner), 0, large, SweepDirection.Counterclockwise, true));
            figure.IsClosed = true;
            PathGeometry geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            return geometry;
        }

        private Point PointOn(double angle, double radius)
        {
            double radians = angle * Math.PI / 180.0;
            return new Point(_cx + Math.Cos(radians) * radius, _cy + Math.Sin(radians) * radius);
        }

        private TextBlock AddLabel(string text, double angle, double radius, double fontSize, Brush brush, bool bold)
        {
            TextBlock label = new TextBlock();
            label.Text = text;
            label.FontSize = fontSize;
            label.Foreground = brush;
            label.FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal;
            label.IsHitTestVisible = false;
            label.TextAlignment = TextAlignment.Center;
            label.Width = 132;
            PositionLabel(label, angle, radius);
            _canvas.Children.Add(label);
            return label;
        }

        private void PositionLabel(TextBlock label, double angle, double radius)
        {
            label.Measure(new Size(132, double.PositiveInfinity));
            double h = Math.Max(16, label.DesiredSize.Height);
            Point p = PointOn(angle, radius);
            Canvas.SetLeft(label, p.X - 66);
            Canvas.SetTop(label, p.Y - h / 2.0);
        }

        private static string ShortCategory(string category)
        {
            if (string.IsNullOrEmpty(category)) return "未分类";
            int slash = category.LastIndexOf('/');
            string tail = slash >= 0 ? category.Substring(slash + 1) : category;
            if (category == "人像精修") return "人像";
            if (category == "服装整理") return "服装整";
            if (category == "背景处理") return "背景处";
            if (category == "创意增强") return "创意";
            if (category == "清晰度增强") return "清晰";
            if (category == "材质增强") return "材质";
            if (tail.Length <= 2) return tail;
            return tail.Substring(0, 2);
        }

        private static string ShortPreset(string name)
        {
            if (string.IsNullOrEmpty(name)) return "";
            return name.Length <= 9 ? name : name.Substring(0, 8) + "…";
        }

        private static double Clamp(double value, double min, double max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        private sealed class RingTheme
        {
            public Brush Sector;
            public Brush SectorAlt;
            public Brush Hover;
            public Brush Hub;
            public Brush Text;
            public Brush Sub;
            public Brush Stroke;
            public Brush Accent;

            public static RingTheme For(string theme)
            {
                bool light = string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
                if (light)
                {
                    return new RingTheme
                    {
                        Sector = Brush(0xF7, 0xF8, 0xF6, 255),
                        SectorAlt = Brush(0xEE, 0xF2, 0xEE, 255),
                        Hover = Brush(0xE8, 0xF4, 0xEC, 255),
                        Hub = Brush(0xFF, 0xFF, 0xFF, 255),
                        Text = Brush(0x2F, 0x38, 0x32, 255),
                        Sub = Brush(0x8A, 0x93, 0x8C, 255),
                        Stroke = Brush(0xDF, 0xE4, 0xDF, 255),
                        Accent = Brush(0x14, 0x8A, 0x50, 255)
                    };
                }
                return new RingTheme
                {
                    Sector = Brush(0x2B, 0x31, 0x35, 255),
                    SectorAlt = Brush(0x25, 0x2A, 0x2E, 255),
                    Hover = Brush(0x18, 0x8A, 0x50, 255),
                    Hub = Brush(0x1D, 0x23, 0x27, 255),
                    Text = Brush(0xF2, 0xF5, 0xF2, 255),
                    Sub = Brush(0x9D, 0xAB, 0xA2, 255),
                    Stroke = Brush(0x45, 0x4D, 0x50, 255),
                    Accent = Brush(0x35, 0xC2, 0x7A, 255)
                };
            }

            private static Brush Brush(byte r, byte g, byte b, byte a)
            {
                SolidColorBrush brush = new SolidColorBrush(Color.FromArgb(a, r, g, b));
                brush.Freeze();
                return brush;
            }
        }
    }
}















