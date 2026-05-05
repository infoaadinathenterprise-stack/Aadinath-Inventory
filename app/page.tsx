import HeroSection  from './components/HeroSection';
import StatsCounter from './components/StatsCounter';
import AboutSection from './components/AboutSection';

export default function HomePage() {
  return (
    <main>
      <HeroSection />
      <StatsCounter />
      <AboutSection />
    </main>
  );
}
