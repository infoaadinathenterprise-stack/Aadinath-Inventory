import HeroSection  from './components/HeroSection';
import StatsCounter from './components/StatsCounter';
import AboutSection from './components/AboutSection';
import HomeJsonLd   from './components/JsonLd';

export default function HomePage() {
  return (
    <main>
      <HomeJsonLd />
      <HeroSection />
      <StatsCounter />
      <AboutSection />
    </main>
  );
}
