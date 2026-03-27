import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  TextInput,
  SafeAreaView,
} from 'react-native';
import { X, Search, ChevronDown } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { Country, COUNTRIES } from '@/constants/countries';

interface CountrySelectorProps {
  selectedCountry: Country;
  onSelectCountry: (country: Country) => void;
}

export default function CountrySelector({ selectedCountry, onSelectCountry }: CountrySelectorProps) {
  const [modalVisible, setModalVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCountries = COUNTRIES.filter(
    (country) =>
      country.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      country.dialCode.includes(searchQuery)
  );

  const handleSelectCountry = (country: Country) => {
    onSelectCountry(country);
    setModalVisible(false);
    setSearchQuery('');
  };

  return (
    <>
      <TouchableOpacity
        style={styles.countryButton}
        onPress={() => setModalVisible(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.flag}>{selectedCountry.flag}</Text>
        <Text style={styles.dialCode}>{selectedCountry.dialCode}</Text>
        <ChevronDown size={16} color={Colors.textSecondary} />
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Country</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setModalVisible(false)}
              activeOpacity={0.7}
            >
              <X size={24} color={Colors.ink} />
            </TouchableOpacity>
          </View>

          <View style={styles.searchContainer}>
            <Search size={20} color={Colors.textSecondary} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search countries..."
              placeholderTextColor={Colors.gray400}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>

          <FlatList
            data={filteredCountries}
            keyExtractor={(item) => item.code}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.countryItem,
                  selectedCountry.code === item.code && styles.countryItemSelected,
                ]}
                onPress={() => handleSelectCountry(item)}
                activeOpacity={0.7}
              >
                <Text style={styles.countryFlag}>{item.flag}</Text>
                <View style={styles.countryInfo}>
                  <Text style={styles.countryName}>{item.name}</Text>
                  <Text style={styles.countryDialCode}>{item.dialCode}</Text>
                </View>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  countryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  flag: {
    fontSize: 24,
  },
  dialCode: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.ink,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.creamDark,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
  },
  closeButton: {
    position: 'absolute',
    right: 20,
    padding: 4,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.creamMedium,
    marginHorizontal: 20,
    marginVertical: 16,
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.ink,
  },
  listContent: {
    paddingHorizontal: 20,
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  countryItemSelected: {
    backgroundColor: 'rgba(243, 106, 63, 0.1)',
  },
  countryFlag: {
    fontSize: 32,
    marginRight: 16,
  },
  countryInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countryName: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.ink,
    flex: 1,
  },
  countryDialCode: {
    fontSize: 16,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  separator: {
    height: 1,
    backgroundColor: Colors.creamDark,
    marginLeft: 60,
  },
});

