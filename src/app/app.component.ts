import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { ProjectsComponent } from './projects/projects.component';
import { HeroSliderComponent } from './hero-slider/hero-slider.component';

type Translations = Record<string, {
  home: string;
  projects: string;
  services: string;
  about: string;
  contact: string;
  heroTitle: string;
  heroSubtitle: string;
  heroCTA: string;
  servicesTitle: string;
  service1Title: string;
  service1Desc: string;
  service2Title: string;
  service2Desc: string;
  service3Title: string;
  service3Desc: string;
  service4Title: string;
  service4Desc: string;
  projectsTitle: string;
  aboutTitle: string;
  aboutText: string;
  contactTitle: string;
}>;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    ProjectsComponent,
    HeroSliderComponent,
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent {
  isMenuOpen = false;
  currentLanguage: keyof Translations = 'bg';

  translations: Translations = {
    en: {
      home: 'Home',
      projects: 'Projects',
      services: 'Services',
      about: 'About',
      contact: 'Contact',
      heroTitle: 'Design Your Dream Kitchen',
      heroSubtitle: 'Custom · Modern · Functional',
      heroCTA: 'Call us',
      servicesTitle: 'Our Services',
      service1Title: 'Measurements taking',
      service1Desc: 'Professional photography of your finished kitchen project.',
      service2Title: 'Design',
      service2Desc: 'Custom 3D design tailored to your space and needs.',
      service3Title: 'Production',
      service3Desc: 'High-quality manufacturing with precision and care.',
      service4Title: 'Installation',
      service4Desc: 'Expert on-site installation and finishing.',
      projectsTitle: 'Projects',
      aboutTitle: 'About us',
      aboutText: 'We believe that the beauty and functionality of furniture does not depend on the price of the individual components used, but on a minimalist humility, silence and unity of all details — aiming for a finished wholeness that complements the space, elevating the person as the main protagonist in their own home or office.',
      contactTitle: 'Contact',
    },
    bg: {
      home: 'Начало',
      projects: 'Проекти',
      services: 'Услуги',
      about: 'За нас',
      contact: 'Контакти',
      heroTitle: 'Кухни по поръчка',
      heroSubtitle: 'Персонализирани · Модерни · Функционални',
      heroCTA: 'Поръчай',
      servicesTitle: 'Нашите Услуги',
      service1Title: 'Заснемане',
      service1Desc: 'Професионално заснемане на вашия завършен кухненски проект.',
      service2Title: 'Проектиране',
      service2Desc: 'Персонализиран 3D дизайн, съобразен с вашето пространство.',
      service3Title: 'Изработка',
      service3Desc: 'Висококачествена изработка с прецизност и внимание към детайла.',
      service4Title: 'Монтаж',
      service4Desc: 'Професионален монтаж на място от опитни специалисти.',
      projectsTitle: 'Проекти',
      aboutTitle: 'За нас',
      aboutText: 'Ние вярваме, че луксът, красотата и функционалността на мебелите не се дължат на цената на използваните отделни детайли, а на минималистична смиреност, тишината и единство на всички детайли, целяща допълване, завършена цялост и съпричастност към обгръщащото пространството, издигаща човекът в основен герой в собственото му жилище или офис.',
      contactTitle: 'Контакти',
    },
  };

  toggleMenu() {
    this.isMenuOpen = !this.isMenuOpen;
  }

  toggleLanguage(lang: keyof Translations) {
    this.currentLanguage = lang;
  }

  scrollTo(sectionId: string) {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
  }
}
