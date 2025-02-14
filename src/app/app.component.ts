import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

type Translations = Record<string, {
        home: string;
        portfolio: string;
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
    }>;

@Component({
    selector: 'app-root',
    standalone: true,
    imports: [CommonModule, MatToolbarModule, MatButtonModule, MatIconModule, MatMenuModule],
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss'],
})
export class AppComponent {
    isMenuOpen = false;
    currentLanguage: keyof Translations = 'bg';

    translations: Translations = {
        en: {
            home: 'Home',
            portfolio: 'Portfolio',
            services: 'Services',
            about: 'About',
            contact: 'Contact',
            heroTitle: 'Design Your Dream Kitchen',
            heroSubtitle: 'Custom, Modern, and Functional Designs',
            heroCTA: 'Call us', // Updated CTA text
            servicesTitle: 'Our Services',
            service1Title: '3D Rendering',
            service1Desc: 'Visualize your kitchen in stunning 3D detail.',
            service2Title: 'Custom Cabinetry',
            service2Desc: 'Tailored cabinets to fit your space perfectly.',
            service3Title: 'Space Planning',
            service3Desc: 'Optimize your kitchen layout for functionality.',
        },
        bg: {
            home: 'Начало',
            portfolio: 'Портфолио',
            services: 'Услуги',
            about: 'За нас',
            contact: 'Контакти',
            heroTitle: 'Проектирайте Вашата Мечтана Кухня',
            heroSubtitle: 'Персонализирани, Модерни и Функционални Дизайни',
            heroCTA: 'Обади ни се', // Updated CTA text
            servicesTitle: 'Нашите Услуги',
            service1Title: 'Заснемане',
            service1Desc: 'Професионално заснемане на вашия кухненски проект.',
            service2Title: 'Кухни',
            service2Desc: 'Персонализирани кухни, съобразени с вашите нужди.',
            service3Title: 'Други мебели',
            service3Desc: 'Мебели за всяка стая, изработени с внимание към детайла.',
        },
    };

    toggleMenu() {
        this.isMenuOpen = !this.isMenuOpen;
    }

    toggleLanguage(lang: keyof Translations) {
        this.currentLanguage = lang;
    }
}
