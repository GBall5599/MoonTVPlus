'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { BackButton } from './BackButton';
import MobileBottomNav from './MobileBottomNav';
import MobileHeader from './MobileHeader';
import Sidebar from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { UpdateNotification } from './UpdateNotification';
import { UserMenu } from './UserMenu';
import { VersionCheckProvider } from './VersionCheckProvider';

interface PageLayoutProps {
  children: React.ReactNode;
  activePath?: string;
  hideNavigation?: boolean; // 控制是否隐藏顶部和底部导航栏
}

const PageLayout = ({ children, activePath = '/', hideNavigation = false }: PageLayoutProps) => {
  const router = useRouter();
  const [backgroundImage, setBackgroundImage] = useState('');
  const shouldShowSharedBackground = !hideNavigation && activePath !== '/play';

  useEffect(() => {
    router.prefetch('/search');
    router.prefetch('/play');
  }, [router]);

  useEffect(() => {
    if (typeof window === 'undefined' || !shouldShowSharedBackground) {
      setBackgroundImage('');
      return;
    }

    const homeBg = (
      window as Window & {
        RUNTIME_CONFIG?: {
          HOME_BACKGROUND_IMAGE?: string;
        };
      }
    ).RUNTIME_CONFIG?.HOME_BACKGROUND_IMAGE;
    if (!homeBg) {
      setBackgroundImage('');
      return;
    }

    const urls = homeBg
      .split('\n')
      .map((url: string) => url.trim())
      .filter((url: string) => url !== '');

    if (urls.length === 0) {
      setBackgroundImage('');
      return;
    }

    const randomIndex = Math.floor(Math.random() * urls.length);
    setBackgroundImage(urls[randomIndex]);
  }, [shouldShowSharedBackground]);

  return (
    <VersionCheckProvider>
      <div className='relative w-full min-h-screen overflow-hidden'>
        {shouldShowSharedBackground && backgroundImage && (
          <>
            <div
              className='absolute inset-0 pointer-events-none bg-cover bg-center bg-no-repeat opacity-45'
              style={{ backgroundImage: `url(${backgroundImage})` }}
            />
            <div className='absolute inset-0 pointer-events-none bg-white/50 dark:bg-gray-950/50' />
          </>
        )}

        {/* 移动端头部 */}
        {!hideNavigation && (
          <MobileHeader showBackButton={['/play', '/live'].includes(activePath)} />
        )}

        {/* 主要布局容器 */}
        <div className='relative z-10 flex md:grid md:grid-cols-[auto_1fr] w-full min-h-screen md:min-h-auto'>
          {/* 侧边栏 - 桌面端显示，移动端隐藏 */}
          {!hideNavigation && (
            <div className='hidden md:block'>
              <Sidebar activePath={activePath} />
            </div>
          )}

          {/* 主内容区域 */}
          <div className='relative min-w-0 flex-1 transition-all duration-300'>
            {/* 桌面端固定顶栏（明暗切换 + 用户）。
                改动前它只是 `absolute top-2 right-4` 且**没有底色**：一方面随内容
                滚走，另一方面大图推荐区（BannerCarousel）从 y=0 铺满，按钮正好压在
                它的右上角 —— 海报深的时候图标几乎看不清。
                现在：`fixed` 贴住视口顶部 + 半透明底 +背景模糊（与 MobileHeader 同款
                观感），并且 main 上留出 md:mt-12 的等高空间，让大图从顶栏下方开始，
                不再与按钮重叠。
                为什么横跨整个宽度（含侧边栏上方）而不只盖主内容区：顶栏是 fixed 定位，
                脱离文档流，CSS 上**读不到侧边栏当前的宽度**（试过把侧边栏宽度做成
                CSS 变量，`aside ~ *` 实际只命中网格占位节点，值传不到顶栏 —— 已用
                真实浏览器探针证伪并放弃）。横跨全宽则两种侧边栏状态下都是对的。
                ⚠ 因此 z 序必须排在侧边栏**之下**（这里 z-20，侧边栏是 z-10 但 DOM 在前，
                故必须显式抬高侧边栏 —— 见 Sidebar 的 z-20）：否则顶栏那层半透明横条会
                盖住侧边栏右上角的折叠按钮，表现为"点了没反应"。
                实测证据：z-30 时布局测试台报告「顶栏 × 折叠按钮 重叠 32x32px」。
                播放页的返回按钮也放进这条顶栏：它原先在 `top-3 left-1`，会被顶栏盖住
                上半截；放进顶栏后两者同层，不再互相遮挡。
                ⚠ 外层保持 pointer-events-none、只让按钮恢复 auto，否则这条横贯顶部的
                透明层会挡住底下靠右的可点区域。 */}
            {!hideNavigation && (
              <div className='pointer-events-none fixed top-0 right-0 left-0 z-20 hidden md:block border-b border-gray-200/50 bg-white/70 backdrop-blur-xl shadow-sm dark:border-gray-700/50 dark:bg-gray-900/70'>
                <div className='flex h-12 items-center justify-between pl-2 pr-4'>
                  <div className='pointer-events-auto'>
                    {['/play', '/live'].includes(activePath) && <BackButton />}
                  </div>
                  <div className='pointer-events-auto flex items-center gap-2'>
                    <ThemeToggle />
                    <UserMenu />
                    <UpdateNotification />
                  </div>
                </div>
              </div>
            )}

            {/* 主内容。
                md:mt-[3.0625rem] = 49px = 顶栏 48px 内容高 + 1px 下边框 —— 用 48px 会
                差 1px（实测「顶栏 × 大图推荐 重叠 1184x1px」），因为这 1px 边框在
                content-box 之外。留够 49px 后大图区完整落在顶栏之下，0 重叠。
                ⚠ 这段留白必须与顶栏同生共死：hideNavigation（网页全屏）时顶栏不渲染，
                再留 49px 就是一条死白（全屏播放看着很明显）。移动端那段的 3rem 是
                MobileHeader 的等高占位，而 MobileHeader 同样受 hideNavigation 控制，
                所以两边都跟着条件走。 */}
            <main
              className={`flex-1 md:min-h-0 mb-14 md:mb-0 mt-[calc(3rem+env(safe-area-inset-top))] ${
                hideNavigation ? 'md:mt-0' : 'md:mt-[3.0625rem]'
              }`}
              style={{
                paddingBottom: 'calc(3.5rem + env(safe-area-inset-bottom))',
              }}
            >
              {children}
            </main>
          </div>
        </div>

        {/* 移动端底部导航 */}
        {!hideNavigation && (
          <div className='md:hidden'>
            <MobileBottomNav activePath={activePath} />
          </div>
        )}
      </div>
    </VersionCheckProvider>
  );
};

export default PageLayout;
